export type SiretStatus = 'pending' | 'verified' | 'inactive' | 'not_found' | 'manual_review' | 'unavailable' | 'invalid' | 'missing';

export interface SiretVerification {
  siret: string;
  status: SiretStatus;
  source: 'insee';
  checkedAt?: string;
  companyName?: string;
  establishmentStatus?: string;
  pdfPath?: string;
  requestId?: string;
  attempts?: number;
  leaseUntil?: number;
  requestedAt?: number;
}

export const normalizeSiret = (value: unknown): string => typeof value === 'string' ? value.replace(/\s/g, '') : '';
export const isSiretFormat = (siret: string): boolean => /^\d{14}$/.test(siret);
const BASE = 'https://api-avis-situation-sirene.insee.fr';
const MAX_BYTES = 5 * 1024 * 1024;

async function readLimited(response: Response): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('sirene-response-too-large');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('sirene-response-too-large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
function currentPeriod(value: unknown): RecordValue | undefined {
  return Array.isArray(value) ? value.map(record).find(period => period.dateFin === null) : undefined;
}

export function parseSireneIdentification(siret: string, data: unknown): Omit<SiretVerification, 'siret' | 'source'> {
  const body = record(data);
  const establishment = Array.isArray(body.etablissements) ? body.etablissements.map(record).find(item => item.siret === siret) : undefined;
  if (!establishment) {
    if (['DIFF_PARTIELLE', 'DIFF_PARTIEL', 'NON_DIFFUSIBLE'].includes(String(body.codeDiffusabilite))) return { status: 'manual_review' };
    // A changed upstream schema must never be treated as an invalid SIRET.
    if (!Array.isArray(body.etablissements)) throw new Error('sirene-unexpected-response');
    return { status: 'not_found' };
  }
  const legal = record(body.uniteLegale);
  if (establishment.statutDiffusionEtablissement !== 'O' || legal.statutDiffusionUniteLegale !== 'O') return { status: 'manual_review' };
  const ep = currentPeriod(establishment.periodesEtablissement);
  const lp = currentPeriod(legal.periodesUniteLegale);
  if (!ep || !lp || !['A', 'F'].includes(String(ep.etatAdministratifEtablissement)) || !['A', 'C'].includes(String(lp.etatAdministratifUniteLegale))) throw new Error('sirene-unexpected-status');
  const name = lp.denominationUniteLegale || [legal.prenom1UniteLegale, legal.nomUniteLegale].filter(Boolean).join(' ');
  return {
    status: ep.etatAdministratifEtablissement === 'A' && lp.etatAdministratifUniteLegale === 'A' ? 'verified' : 'inactive',
    establishmentStatus: String(ep.etatAdministratifEtablissement),
    ...(typeof name === 'string' && name ? { companyName: name } : {}),
  };
}

async function retrievePublicVerification(siret: string, fetcher: typeof fetch): Promise<{ verification: SiretVerification; pdf?: Buffer }> {
  const response = await fetcher(`https://recherche-entreprises.api.gouv.fr/search?q=${siret}&per_page=1`, {
    signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('sirene-unavailable');
  const body = record(JSON.parse((await readLimited(response)).toString('utf8')));
  if (!Array.isArray(body.results)) throw new Error('sirene-unexpected-response');
  if (body.results.length === 0 && body.total_results === 0) return { verification: { siret, source: 'insee', status: 'not_found', checkedAt: new Date().toISOString() } };
  const company = body.results.map(record).find(item => item.siren === siret.slice(0, 9));
  if (!company) throw new Error('sirene-unexpected-response');
  const establishments = [record(company.siege), ...(Array.isArray(company.matching_etablissements) ? company.matching_etablissements.map(record) : [])];
  const establishment = establishments.find(item => item.siret === siret);
  if (!establishment || !['A', 'F'].includes(String(establishment.etat_administratif))
    || !['A', 'C'].includes(String(company.etat_administratif))) throw new Error('sirene-unexpected-status');
  return retrieveOptionalPdf({
    siret, source: 'insee', checkedAt: new Date().toISOString(),
    status: establishment.etat_administratif === 'A' && company.etat_administratif === 'A' ? 'verified' : 'inactive',
    establishmentStatus: String(establishment.etat_administratif),
  }, fetcher);
}

async function retrieveOptionalPdf(verification: SiretVerification, fetcher: typeof fetch): Promise<{ verification: SiretVerification; pdf?: Buffer }> {
  if (!['verified', 'inactive'].includes(verification.status)) return { verification };
  try {
    const document = await fetcher(`${BASE}/identification/pdf/${verification.siret}`, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { Accept: 'application/pdf' } });
    if (!document.ok || !document.headers.get('content-type')?.includes('application/pdf')) return { verification };
    const pdf = await readLimited(document);
    if (pdf.length < 20 || pdf.subarray(0, 5).toString() !== '%PDF-') return { verification };
    return { verification, pdf };
  } catch { return { verification }; }
}

export async function retrieveSireneNotice(siret: string, fetcher: typeof fetch = fetch): Promise<{ verification: SiretVerification; pdf?: Buffer }> {
  if (!isSiretFormat(siret)) return { verification: { siret, source: 'insee', status: 'invalid' } };
  const response = await fetcher(`${BASE}/identification/siret/${siret}`, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { Accept: 'application/json' } });
  if (response.status === 404) return { verification: { siret, source: 'insee', status: 'not_found' } };
  if ([403, 451].includes(response.status)) return retrievePublicVerification(siret, fetcher);
  if (response.status === 401 && response.headers.get('content-type')?.includes('application/json')) {
    const error = record(JSON.parse((await readLimited(response)).toString('utf8')));
    if (error.codeDiffusabilite === 'IDENT_MANQUANT') return retrievePublicVerification(siret, fetcher);
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('sirene-unavailable');
  const details = parseSireneIdentification(siret, JSON.parse((await readLimited(response)).toString('utf8')));
  const verification: SiretVerification = { siret, source: 'insee', checkedAt: new Date().toISOString(), ...details };
  if (verification.status === 'manual_review') return retrievePublicVerification(siret, fetcher);
  return retrieveOptionalPdf(verification, fetcher);
}
