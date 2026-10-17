// MbiInventra RCM Academy — lab data: fictional payers, claim-scrubber rules, denial scenarios.
// All data is fictional and for training only.
'use strict';

const PAYERS = {
  medicare: { name: 'Medicare (Simulated)', timelyFilingDays: 365, no59: true,
    note: 'Requires XE/XS/XP/XU instead of -59. Timely filing: 12 months.' },
  bcbs: { name: 'BlueCross BlueShield (Simulated)', timelyFilingDays: 180, no59: false,
    note: 'Timely filing: 180 days from DOS.' },
  aetna: { name: 'Aetna (Simulated)', timelyFilingDays: 120, no59: false,
    note: 'Timely filing: 120 days. Strict prior-auth on advanced imaging.' },
  uhc: { name: 'UnitedHealthcare (Simulated)', timelyFilingDays: 90, no59: false,
    note: 'Timely filing: 90 days — the tightest window. File fast.' },
};

const ICD_RE = /^[A-TV-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/i;
const CPT_RE = /^\d{5}$/;
const NPI_RE = /^\d{10}$/;
const EM_RE = /^(9920[2-5]|9921[1-5]|9938[1-9]|9939[0-9]|9949[0-9])$/;

function isEM(cpt) { return EM_RE.test(cpt); }

// Server-side claim scrubber. Returns { errors:[{code,field,msg}], warnings:[...], score, verdict }.
function scrubClaim(c) {
  const errors = [], warnings = [];
  const E = (code, field, msg) => errors.push({ code, field, msg });
  const W = (code, field, msg) => warnings.push({ code, field, msg });
  const payer = PAYERS[c.payer];

  if (!c.patientId) E('MISS-001', 'patient', 'Patient is required.');
  if (!payer) E('MISS-002', 'payer', 'Payer is required.');
  if (!c.dos) E('MISS-003', 'dos', 'Date of service is required.');
  if (!NPI_RE.test(String(c.npiR || ''))) E('NPI-001', 'npiR', 'Rendering NPI must be exactly 10 digits.');
  if (!NPI_RE.test(String(c.npiB || ''))) E('NPI-002', 'npiB', 'Billing NPI must be exactly 10 digits.');
  if (!/^\d{2}$/.test(String(c.pos || ''))) E('POS-001', 'pos', 'Place of service must be a 2-digit code (e.g., 11 = Office).');

  const icds = (c.icds || []).map(s => String(s || '').trim().toUpperCase()).filter(Boolean);
  if (!icds.length) E('DX-001', 'icds', 'At least one ICD-10 diagnosis code is required.');
  icds.forEach((d, i) => { if (!ICD_RE.test(d)) E('DX-002', 'icds', `Diagnosis ${i + 1} ("${d}") is not a valid ICD-10 format.`); });

  const lines = c.lines || [];
  if (!lines.length) E('LN-001', 'lines', 'At least one service line is required.');
  const seen = {};
  lines.forEach((l, i) => {
    const tag = `Line ${i + 1}`;
    const cpt = String(l.cpt || '').trim();
    if (!CPT_RE.test(cpt)) E('CPT-001', 'lines', `${tag}: CPT "${l.cpt || '—'}" must be 5 digits.`);
    const dx = parseInt(l.dx, 10);
    if (!dx || dx < 1 || dx > icds.length) E('DX-003', 'lines', `${tag}: diagnosis pointer must be 1–${icds.length || 1}.`);
    const chg = parseFloat(l.charge);
    if (!(chg > 0)) E('CHG-001', 'lines', `${tag}: charge must be greater than 0.`);
    const un = parseInt(l.units, 10);
    if (!un || un < 1 || un > 99) E('UNT-001', 'lines', `${tag}: units must be 1–99.`);
    const mod = String(l.mod || '').trim().toUpperCase();
    if (mod === '59' && payer && payer.no59)
      E('MOD-001', 'lines', `${tag}: ${payer.name} does not accept -59 — use XE, XS, XP or XU.`);
    else if (mod === '59')
      W('MOD-002', 'lines', `${tag}: -59 is heavily audited; use X-modifiers when possible.`);
    if (mod === '25' && !isEM(cpt))
      E('MOD-003', 'lines', `${tag}: -25 is only valid on E/M codes, not ${cpt || '—'}.`);
    if (mod && !/^(25|59|X[ESPU]|26|TC|76|77|LT|RT|50)$/.test(mod))
      W('MOD-004', 'lines', `${tag}: modifier "${mod}" is unusual — verify it.`);
    if (CPT_RE.test(cpt)) {
      const key = cpt + '|' + (c.dos || '');
      if (seen[key] && !mod) W('DUP-001', 'lines', `${tag}: duplicate ${cpt} on same DOS without a distinct modifier — bundling risk (CO-97).`);
      seen[key] = true;
    }
    if (cpt === '90837' && icds.length && !/^F/i.test(icds[0]))
      W('MN-001', 'lines', `${tag}: 90837 (psychotherapy) with non-behavioral primary diagnosis — medical-necessity risk (CO-96).`);
  });

  if (payer && c.dos) {
    const dos = new Date(c.dos + 'T12:00:00Z');
    if (!isNaN(dos)) {
      const days = Math.floor((Date.now() - dos.getTime()) / 86400000);
      if (days > payer.timelyFilingDays)
        E('TF-001', 'dos', `DOS is ${days} days old — exceeds ${payer.name} timely-filing limit of ${payer.timelyFilingDays} days (CO-29).`);
      else if (days > payer.timelyFilingDays - 30)
        W('TF-002', 'dos', `DOS is ${days} days old — approaching the ${payer.timelyFilingDays}-day timely-filing limit. File now.`);
    }
  }

  const score = Math.max(0, 100 - errors.length * 15 - warnings.length * 5);
  const verdict = errors.length ? 'REJECTED'
    : warnings.length ? 'ACCEPTED WITH WARNINGS' : 'CLEAN';
  return { errors, warnings, score, verdict };
}

// ---- Denial Crime-Scene Lab scenarios (fictional) ----
const DENIALS = [
  {
    id: 'DEN-01', title: 'Therapy denied as routine', difficulty: 'Beginner',
    payer: 'Medicare (Simulated)', carc: 'CO-96', carcLabel: 'Non-covered charge(s)',
    rarc: 'N390', rarcLabel: 'Service not covered when performed with routine diagnosis',
    billed: 120, paid: 0,
    snapshot: [
      ['Patient', 'PT-10009 · DOB 07/14/1978'], ['DOS', '2026-08-02'], ['CPT', '97140 — Manual therapy, 1 unit'],
      ['ICD-10', 'Z00.00 — Encounter for general adult medical examination'],
      ['Rendering NPI', '1234567890'], ['Place of service', '11 — Office'],
    ],
    diagnosisOptions: [
      { t: 'Timely filing — claim submitted too late', correct: false },
      { t: 'Medical necessity — routine diagnosis does not support therapy', correct: true },
      { t: 'Bundling — therapy bundled into the office visit', correct: false },
      { t: 'Missing information — NPI invalid', correct: false },
    ],
    fixOptions: [
      { t: 'Add modifier -59 to 97140', correct: false },
      { t: 'Add a supporting medical diagnosis (e.g., M54.5 low back pain) with documentation', correct: true },
      { t: 'Increase the billed charge to $180', correct: false },
      { t: 'Change place of service to 22', correct: false },
    ],
    decisionOptions: [
      { t: 'Write off — nothing can be done', correct: false },
      { t: 'Submit a corrected claim with the supporting diagnosis', correct: true },
      { t: 'Bill the patient the full $120 immediately', correct: false },
      { t: 'Appeal with no new information', correct: false },
    ],
    explain: {
      diagnosis: 'CO-96 with a Z-code: Medicare never covers therapy billed as routine. The diagnosis must establish medical necessity.',
      fix: 'A medically-indicative ICD (e.g., M54.5) tied to documentation gives the payer a payable reason.',
      decision: 'A corrected claim with new information is the right move — an appeal with no new info would fail again.',
    },
  },
  {
    id: 'DEN-02', title: 'E/M + therapy bundled', difficulty: 'Intermediate',
    payer: 'BlueCross BlueShield (Simulated)', carc: 'CO-97',
    carcLabel: 'Payment adjusted because the benefit for this service is included in another service',
    rarc: 'M15', rarcLabel: 'Separately billed services/tests have been bundled',
    billed: 285, paid: 135,
    snapshot: [
      ['Patient', 'PT-10011 · DOB 03/22/1990'], ['DOS', '2026-09-10'],
      ['Line 1', '99213 — Office visit, est. patient'], ['Line 2', '97110 — Therapeutic exercises, 2 units (no modifier)'],
      ['ICD-10', 'M25.511 — Pain in right shoulder'], ['Rendering NPI', '1234567890'],
    ],
    diagnosisOptions: [
      { t: 'NCCI bundling — 97110 bundled into 99213 without a bypass modifier', correct: true },
      { t: 'Timely filing — DOS too old', correct: false },
      { t: 'Non-covered — therapy never covered', correct: false },
      { t: 'Duplicate claim submitted', correct: false },
    ],
    fixOptions: [
      { t: 'Append XS modifier to 97110 (separate structure/same-day distinct service)', correct: true },
      { t: 'Delete 97110 from the claim', correct: false },
      { t: 'Add modifier -25 to 97110', correct: false },
      { t: 'Rebill both lines with higher charges', correct: false },
    ],
    decisionOptions: [
      { t: 'Submit a corrected claim with the XS modifier and notes', correct: true },
      { t: 'Write off the $150 — bundling is final', correct: false },
      { t: 'Bill the patient for the bundled amount', correct: false },
      { t: 'Resubmit the identical claim hoping it passes', correct: false },
    ],
    explain: {
      diagnosis: 'CO-97 + M15 is the classic NCCI PTP bundling denial: the therapy was absorbed into the E/M payment.',
      fix: 'When the therapy is a genuinely distinct same-day service, XS (separate structure) bypasses the edit — with documentation.',
      decision: 'A corrected claim with the modifier and supporting notes is the correct next step.',
    },
  },
  {
    id: 'DEN-03', title: 'Filed 200 days late', difficulty: 'Beginner',
    payer: 'UnitedHealthcare (Simulated)', carc: 'CO-29',
    carcLabel: 'The time limit for filing has expired',
    rarc: '', rarcLabel: '',
    billed: 175, paid: 0,
    snapshot: [
      ['Patient', 'PT-10005 · DOB 11/02/1965'], ['DOS', '2026-03-12 (≈200 days ago)'],
      ['CPT', '99213 — Office visit'], ['ICD-10', 'J06.9 — Acute upper respiratory infection'],
      ['Filing limit', 'UHC (Simulated): 90 days'],
    ],
    diagnosisOptions: [
      { t: 'Timely filing — DOS exceeds the 90-day limit', correct: true },
      { t: 'Medical necessity — URI does not support 99213', correct: false },
      { t: 'Bundling with a prior visit', correct: false },
      { t: 'Patient ineligible on DOS', correct: false },
    ],
    fixOptions: [
      { t: 'No fix available — the filing window has closed', correct: true },
      { t: 'Change the DOS to a recent date', correct: false },
      { t: 'Add modifier -25 to 99213', correct: false },
      { t: 'Resubmit with a different ICD', correct: false },
    ],
    decisionOptions: [
      { t: 'Write off as provider liability — timely filing denials cannot be billed to the patient', correct: true },
      { t: 'Bill the patient the full $175', correct: false },
      { t: 'Appeal expecting payment', correct: false },
      { t: 'Alter the DOS and resubmit', correct: false },
    ],
    explain: {
      diagnosis: 'CO-29 is final when the DOS is past the payer limit — UHC (Simulated) allows only 90 days.',
      fix: 'There is no legitimate fix; changing the DOS would be fraud.',
      decision: 'Contract terms make timely-filing write-offs provider liability — never bill the patient.',
    },
  },
  {
    id: 'DEN-04', title: 'The $200 visit that paid $112', difficulty: 'Beginner',
    payer: 'Aetna (Simulated)', carc: 'CO-45', carcLabel: 'Charge exceeds fee schedule / contractual adjustment',
    rarc: '', rarcLabel: '',
    billed: 200, paid: 112,
    snapshot: [
      ['Patient', 'PT-10007 · DOB 05/30/1988'], ['DOS', '2026-09-28'],
      ['CPT', '90837 — Psychotherapy, 60 minutes'], ['Billed', '$200.00'],
      ['Allowed', '$140.00'], ['CO-45 adjustment', '$60.00'], ['PR-2 coinsurance', '$28.00'], ['Payer paid', '$112.00'],
    ],
    diagnosisOptions: [
      { t: 'This is not a denial — normal contractual adjustment + patient coinsurance', correct: true },
      { t: 'Bundling — 90837 bundled into another code', correct: false },
      { t: 'Timely filing expired', correct: false },
      { t: 'Medical necessity denial', correct: false },
    ],
    fixOptions: [
      { t: 'No fix needed — post the adjustment as agreed', correct: true },
      { t: 'Appeal the CO-45 adjustment', correct: false },
      { t: 'Rebill at $140 to avoid the adjustment', correct: false },
      { t: 'Add modifier -59', correct: false },
    ],
    decisionOptions: [
      { t: 'Post ERA: $60 adjustment, transfer $28 coinsurance to patient responsibility', correct: true },
      { t: 'Write off the $28 patient balance', correct: false },
      { t: 'Appeal for the full $200', correct: false },
      { t: 'Send the entire $88 to collections', correct: false },
    ],
    explain: {
      diagnosis: 'CO-45 is the contracted rate doing its job — $200 billed, $140 allowed. PR-2 is the patient share.',
      fix: 'Contractual adjustments are not appealable; rebilling lower changes nothing.',
      decision: 'Post the ERA, adjust $60, move $28 to patient balance and statement it.',
    },
  },
  {
    id: 'DEN-05', title: 'Rejected: NPI missing', difficulty: 'Beginner',
    payer: 'Medicare (Simulated)', carc: 'CO-16',
    carcLabel: 'Claim/service lacks information needed for adjudication',
    rarc: 'N257', rarcLabel: 'Missing or invalid rendering provider NPI',
    billed: 135, paid: 0,
    snapshot: [
      ['Patient', 'PT-10013 · DOB 09/19/1974'], ['DOS', '2026-10-01'],
      ['CPT', '99213 — Office visit'], ['ICD-10', 'E11.65 — Type 2 diabetes with hyperglycemia'],
      ['Rendering NPI', '(blank)'], ['Billing NPI', '1234567890'],
    ],
    diagnosisOptions: [
      { t: 'Missing/invalid information — rendering NPI blank', correct: true },
      { t: 'Medical necessity — diabetes does not support 99213', correct: false },
      { t: 'Duplicate claim', correct: false },
      { t: 'Patient not eligible', correct: false },
    ],
    fixOptions: [
      { t: 'Enter the 10-digit rendering NPI (Box 24J)', correct: true },
      { t: 'Change the ICD to Z00.00', correct: false },
      { t: 'Add modifier -25', correct: false },
      { t: 'Increase units to 2', correct: false },
    ],
    decisionOptions: [
      { t: 'Submit a corrected claim with the NPI', correct: true },
      { t: 'Write off — rejections cannot be fixed', correct: false },
      { t: 'Appeal the rejection', correct: false },
      { t: 'Bill the patient', correct: false },
    ],
    explain: {
      diagnosis: 'CO-16 + N257: front-end rejection, not a true denial — the claim never adjudicated.',
      fix: 'A rejection is fixed with a corrected claim, not an appeal.',
      decision: 'Correct and resubmit; rejections have the highest recovery rate in the building.',
    },
  },
  {
    id: 'DEN-06', title: 'MRI without prior auth', difficulty: 'Advanced',
    payer: 'Aetna (Simulated)', carc: 'OA-23',
    carcLabel: 'Payment adjusted for prior payer — authorization required, not obtained',
    rarc: '', rarcLabel: '',
    billed: 1450, paid: 0,
    snapshot: [
      ['Patient', 'PT-10008 · DOB 12/05/1959'], ['DOS', '2026-09-15'],
      ['CPT', '70553 — MRI brain without + with contrast'], ['ICD-10', 'R51 — Headache'],
      ['Prior auth on file', 'None'], ['Payer note', 'Advanced imaging requires prior authorization'],
    ],
    diagnosisOptions: [
      { t: 'Prior authorization missing for advanced imaging', correct: true },
      { t: 'Timely filing expired', correct: false },
      { t: 'Bundling of contrast with MRI', correct: false },
      { t: 'Non-covered — MRI never covered', correct: false },
    ],
    fixOptions: [
      { t: 'Request retro authorization with clinical notes supporting medical necessity', correct: true },
      { t: 'Change CPT to 70551 (without contrast) to dodge auth', correct: false },
      { t: 'Add modifier -59', correct: false },
      { t: 'Rebill as two separate MRIs', correct: false },
    ],
    decisionOptions: [
      { t: 'Appeal with the retro-auth approval and records', correct: true },
      { t: 'Write off immediately — auth denials never overturn', correct: false },
      { t: 'Bill the patient $1,450', correct: false },
      { t: 'Resubmit the identical claim', correct: false },
    ],
    explain: {
      diagnosis: 'OA-23: the service needed prior authorization and none was on file — an ordering-side failure.',
      fix: 'Retro-auth with strong clinical notes is the only legitimate path; downcoding to dodge auth is abuse.',
      decision: 'Appeal with the approval attached — auth-related appeals overturn at high rates when documented.',
    },
  },
];

module.exports = { PAYERS, scrubClaim, DENIALS };
