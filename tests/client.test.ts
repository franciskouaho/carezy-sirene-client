import { describe, expect, it, vi } from 'vitest';
import { normalizeSiret, parseSireneIdentification, retrieveSireneNotice } from '../src/index.js';

const siret = '12345678900012';
function identity(establishment = 'A', legal = 'A') {
  return { codeDiffusabilite: 'DIFF_OK', etablissements: [
    { siret: '12345678900020', statutDiffusionEtablissement: 'O', periodesEtablissement: [{ dateFin: null, etatAdministratifEtablissement: 'A' }] },
    { siret, statutDiffusionEtablissement: 'O', periodesEtablissement: [{ dateFin: '2020-01-01', etatAdministratifEtablissement: 'F' }, { dateFin: null, etatAdministratifEtablissement: establishment }] },
  ], uniteLegale: { statutDiffusionUniteLegale: 'O', periodesUniteLegale: [{ dateFin: null, etatAdministratifUniteLegale: legal, denominationUniteLegale: 'Test Entreprise' }] } };
}
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function publicIdentity(number = siret, establishment = 'A', legal = 'A') {
  return { results: [{ siren: number.slice(0, 9), etat_administratif: legal, siege: { siret: number, etat_administratif: establishment }, matching_etablissements: [] as Array<{ siret: string; etat_administratif: string }> }], total_results: 1 };
}
const pdf = () => new Response('%PDF-1.7\nOfficial notice fixture', { headers: { 'content-type': 'application/pdf' } });

describe('Sirene official source', () => {
  it('normalises spaces without accepting letters', () => { expect(normalizeSiret('123 456 789 00012')).toBe(siret); });
  it('verifies exact establishment, not the active headquarters', () => {
    expect(parseSireneIdentification(siret, identity('F'))).toMatchObject({ status: 'inactive', establishmentStatus: 'F' });
    expect(parseSireneIdentification(siret, identity('A', 'C')).status).toBe('inactive');
  });
  it('requires the current administrative periods', () => {
    const data = identity(); data.etablissements[1].periodesEtablissement = [];
    expect(() => parseSireneIdentification(siret, data)).toThrow('sirene-unexpected-status');
  });
  it('never substitutes another SIRET for the requested one', () => {
    expect(parseSireneIdentification('45678912300012', identity()).status).toBe('not_found');
  });
  it('requires manual review for restricted diffusion', () => {
    const data = identity();data.uniteLegale.statutDiffusionUniteLegale = 'P';
    expect(parseSireneIdentification(siret, data).status).toBe('manual_review');
  });
  it('treats unexpected schema as provider error', () => {
    expect(() => parseSireneIdentification(siret, {})).toThrow('sirene-unexpected-response');
  });
  it('retrieves real PDF only after exact active identification', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(identity())).mockResolvedValueOnce(pdf());
    const result = await retrieveSireneNotice(siret, fetcher);
    expect(result.verification).toMatchObject({ siret, status: 'verified', source: 'insee', companyName: 'Test Entreprise' });
    expect(result.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(fetcher.mock.calls[1][0]).toBe(`https://api-avis-situation-sirene.insee.fr/identification/pdf/${siret}`);
  });
  it('does not call Insee for malformed input', async () => {
    const fetcher = vi.fn(); expect((await retrieveSireneNotice('ABCDEFGHIJKLMN', fetcher)).verification.status).toBe('invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([403, 451])('verifies restricted access (%s) using exact public establishment', async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status })).mockResolvedValueOnce(json(publicIdentity())).mockResolvedValueOnce(new Response('', { status: 401 }));
    expect((await retrieveSireneNotice(siret, fetcher)).verification.status).toBe('verified');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('handles not-found without requesting PDF', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    expect((await retrieveSireneNotice(siret, fetcher)).verification.status).toBe('not_found');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('verifies a restricted SIRET without requiring its PDF', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, codeDiffusabilite: 'IDENT_MANQUANT', message: "Problème d'authentification : L’entreprise n’est pas diffusable, veuillez vous identifier" }), { status: 401, headers: { 'content-type': 'application/json' } })).mockResolvedValueOnce(json(publicIdentity('98765432100019'))).mockResolvedValueOnce(new Response('', { status: 401 }));
    const result = await retrieveSireneNotice('98765432100019', fetcher);
    expect(result.verification).toMatchObject({ siret: '98765432100019', status: 'verified' });
    expect(result.pdf).toBeUndefined();
  });
  it.each(['F', 'A'])('uses exact establishment state %s, not another active headquarters', async status => {
    const data = publicIdentity(siret, status);
    data.results[0].siege = { siret: '12345678900020', etat_administratif: 'A' };
    data.results[0].matching_etablissements = [{ siret, etat_administratif: status }];
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(json(data)).mockResolvedValueOnce(pdf());
    expect((await retrieveSireneNotice(siret, fetcher)).verification.status).toBe(status === 'A' ? 'verified' : 'inactive');
  });
  it('rejects public results that lack the exact requested establishment', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(json(publicIdentity('12345678900020')));
    await expect(retrieveSireneNotice(siret, fetcher)).rejects.toThrow('sirene-unexpected-status');
  });
  it('keeps unavailable public provider as unavailable, not verified', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(retrieveSireneNotice(siret, fetcher)).rejects.toThrow('sirene-unavailable');
  });
  it('does not verify an active establishment belonging to a closed company', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(json(publicIdentity(siret, 'A', 'C'))).mockResolvedValueOnce(pdf());
    expect((await retrieveSireneNotice(siret, fetcher)).verification.status).toBe('inactive');
  });
  it('rejects unknown public administrative states', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(json(publicIdentity(siret, 'unknown')));
    await expect(retrieveSireneNotice(siret, fetcher)).rejects.toThrow('sirene-unexpected-status');
  });
  it('reports an empty public result without attempting a PDF', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(json({ results: [], total_results: 0 }));
    expect((await retrieveSireneNotice(siret, fetcher)).verification.status).toBe('not_found');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('attaches an accessible PDF after public verification', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(json(publicIdentity())).mockResolvedValueOnce(pdf());
    const result = await retrieveSireneNotice(siret, fetcher);
    expect(result.verification.status).toBe('verified');
    expect(result.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('does not lose a valid result when the PDF request times out', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(identity())).mockRejectedValueOnce(new Error('timeout'));
    const result = await retrieveSireneNotice(siret, fetcher);
    expect(result.verification.status).toBe('verified'); expect(result.pdf).toBeUndefined();
  });
  it('keeps unrelated authentication failures as provider errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 401 }), { status: 401, headers: { 'content-type': 'application/json' } }));
    await expect(retrieveSireneNotice(siret, fetcher)).rejects.toThrow('sirene-unavailable');
  });
  it.each([429, 500])('retries provider failure (%s), not an invalid SIRET', async status => {
    await expect(retrieveSireneNotice(siret, vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toThrow('sirene-unavailable');
  });
  it('refuses HTML returned in place of PDF', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(identity())).mockResolvedValueOnce(new Response('<html>error</html>', { headers: { 'content-type': 'application/pdf' } }));
    const result = await retrieveSireneNotice(siret, fetcher);
    expect(result.verification.status).toBe('verified'); expect(result.pdf).toBeUndefined();
  });
  it('bounds document size', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(identity())).mockResolvedValueOnce(new Response('pdf', { headers: { 'content-type': 'application/pdf', 'content-length': String(6 * 1024 * 1024) } }));
    const result = await retrieveSireneNotice(siret, fetcher);
    expect(result.verification.status).toBe('verified'); expect(result.pdf).toBeUndefined();
  });
});
