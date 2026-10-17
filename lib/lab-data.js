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


// ===== ERA POSTING SIMULATOR scenarios =====
// Each scenario is a realistic ERA (835) with claim lines.
// Trainee must compute: contractual adjustment, patient balance, and pick the correct next action.
const ERA = [
  {
    id: 'ERA-01', title: 'Standard office visit — copay applied', difficulty: 'Beginner',
    payer: 'BlueCross BlueShield (Simulated)', checkNo: 'EFT-88412', payDate: '2026-09-15',
    payee: 'MbiInventra Family Practice', npi: '1234567890',
    patient: 'PT-10005 · DOB 04/18/1985', claimNo: 'CLM-2026-10482', dos: '2026-09-02',
    lines: [
      { cpt: '99213', desc: 'Office visit, established patient', billed: 150, allowed: 100, paid: 80,
        carc: 'CO-45', carcLabel: 'Charge exceeds fee schedule', rarc: '', rarcLabel: '',
        prCode: 'PR-3', prLabel: 'Copay', prAmt: 20,
        correctAdj: 50, correctPtBal: 20, correctAction: 'bill-patient',
        why: 'Billed $150 − allowed $100 = $50 contractual write-off (CO-45). Paid $80 of the $100 allowed; the $20 copay (PR-3) is patient responsibility.' },
    ],
  },
  {
    id: 'ERA-02', title: 'Fully paid — no adjustment needed', difficulty: 'Beginner',
    payer: 'Medicare (Simulated)', checkNo: 'EFT-88413', payDate: '2026-09-16',
    payee: 'MbiInventra Family Practice', npi: '1234567890',
    patient: 'PT-10007 · DOB 11/30/1972', claimNo: 'CLM-2026-10483', dos: '2026-09-03',
    lines: [
      { cpt: '99214', desc: 'Office visit, est. patient, moderate complexity', billed: 200, allowed: 180, paid: 180,
        carc: 'CO-45', carcLabel: 'Charge exceeds fee schedule', rarc: '', rarcLabel: '',
        prCode: '', prLabel: '', prAmt: 0,
        correctAdj: 20, correctPtBal: 0, correctAction: 'post-paid',
        why: 'Billed $200 − allowed $180 = $20 contractual write-off (CO-45). Payer paid the full allowed amount — nothing to bill the patient.' },
    ],
  },
  {
    id: 'ERA-03', title: 'Underpayment — flag it, do not write off', difficulty: 'Intermediate',
    payer: 'Aetna (Simulated)', checkNo: 'EFT-88414', payDate: '2026-09-17',
    payee: 'MbiInventra Orthopedics', npi: '1234567890',
    patient: 'PT-10011 · DOB 03/22/1990', claimNo: 'CLM-2026-10484', dos: '2026-09-05',
    lines: [
      { cpt: '20610', desc: 'Arthrocentesis, major joint', billed: 300, allowed: 250, paid: 150,
        carc: 'CO-45', carcLabel: 'Charge exceeds fee schedule', rarc: '', rarcLabel: '',
        prCode: '', prLabel: '', prAmt: 0,
        correctAdj: 50, correctPtBal: 0, correctAction: 'flag-underpayment',
        why: 'Contractual adjustment is only billed − allowed = $50 (CO-45). The payer owes $250 but paid $150 — a $100 underpayment. Never write off the missing $100; flag for follow-up and call the payer.' },
    ],
  },
  {
    id: 'ERA-04', title: 'Deductible — patient owes the balance', difficulty: 'Intermediate',
    payer: 'UnitedHealthcare (Simulated)', checkNo: 'EFT-88415', payDate: '2026-09-18',
    payee: 'MbiInventra Family Practice', npi: '1234567890',
    patient: 'PT-10009 · DOB 07/14/1978', claimNo: 'CLM-2026-10485', dos: '2026-09-06',
    lines: [
      { cpt: '36415', desc: 'Venipuncture', billed: 50, allowed: 35, paid: 0,
        carc: 'CO-45', carcLabel: 'Charge exceeds fee schedule', rarc: '', rarcLabel: '',
        prCode: 'PR-1', prLabel: 'Deductible', prAmt: 35,
        correctAdj: 15, correctPtBal: 35, correctAction: 'bill-patient',
        why: 'Billed $50 − allowed $35 = $15 contractual write-off (CO-45). The full $35 allowed went to the patient\'s unmet deductible (PR-1) — bill the patient $35, not the payer.' },
    ],
  },
  {
    id: 'ERA-05', title: 'Denied line — route to workup, not write-off', difficulty: 'Advanced',
    payer: 'Medicare (Simulated)', checkNo: 'EFT-88416', payDate: '2026-09-19',
    payee: 'MbiInventra Rehab', npi: '1234567890',
    patient: 'PT-10012 · DOB 09/05/1965', claimNo: 'CLM-2026-10486', dos: '2026-09-08',
    lines: [
      { cpt: '97140', desc: 'Manual therapy, 1 unit', billed: 120, allowed: 0, paid: 0,
        carc: 'CO-96', carcLabel: 'Non-covered charge(s)', rarc: 'N390', rarcLabel: 'Service not covered with routine diagnosis',
        prCode: '', prLabel: '', prAmt: 0,
        correctAdj: 0, correctPtBal: 0, correctAction: 'denial-workup',
        why: 'CO-96 with $0 allowed: this is a denial, not a payable line. Do NOT post a $120 write-off yet — route to denial workup. The fix may be a corrected claim with a supporting diagnosis.' },
    ],
  },
  {
    id: 'ERA-06', title: 'Multi-line: paid visit + bundled therapy', difficulty: 'Advanced',
    payer: 'BlueCross BlueShield (Simulated)', checkNo: 'EFT-88417', payDate: '2026-09-20',
    payee: 'MbiInventra Rehab', npi: '1234567890',
    patient: 'PT-10013 · DOB 01/25/1988', claimNo: 'CLM-2026-10487', dos: '2026-09-10',
    lines: [
      { cpt: '99213', desc: 'Office visit, established patient', billed: 150, allowed: 100, paid: 80,
        carc: 'CO-45', carcLabel: 'Charge exceeds fee schedule', rarc: '', rarcLabel: '',
        prCode: 'PR-3', prLabel: 'Copay', prAmt: 20,
        correctAdj: 50, correctPtBal: 20, correctAction: 'bill-patient',
        why: 'Line 1 is clean: $50 contractual write-off (CO-45), $20 copay to patient (PR-3).' },
      { cpt: '97110', desc: 'Therapeutic exercises, 2 units (no modifier)', billed: 135, allowed: 0, paid: 0,
        carc: 'CO-97', carcLabel: 'Benefit included in another service', rarc: 'M15', rarcLabel: 'Services bundled',
        prCode: '', prLabel: '', prAmt: 0,
        correctAdj: 0, correctPtBal: 0, correctAction: 'denial-workup',
        why: 'Line 2 denied as CO-97/M15 bundling: 97110 without a modifier was absorbed into 99213. Route to denial workup — check NCCI and whether a -59/XS modifier with distinct documentation supports a corrected claim.' },
    ],
  },
];

const ERA_ACTIONS = [
  { v: 'post-paid', t: 'Post as paid — close the line' },
  { v: 'bill-patient', t: 'Bill the patient the balance' },
  { v: 'flag-underpayment', t: 'Flag underpayment — follow up with payer' },
  { v: 'denial-workup', t: 'Route to denial workup' },
  { v: 'write-off', t: 'Write off the balance' },
];


// ================= PATIENT STATEMENTS + COLLECTIONS =================
// 5 scenarios: statement math, payment plans, disputes, write-offs
const STATEMENTS = [
  {
    id: 'STMT-01', title: 'Simple copay collection', difficulty: 'Beginner',
    patient: 'Maria Gonzalez · PT-10005 · DOB 04/18/1985',
    dos: '2026-09-02', cpt: '99213 — Office visit, established patient',
    eob: { billed: 150, allowed: 100, paid: 80, carc: 'CO-45', prCode: 'PR-3', prAmt: 20 },
    statement: { stmtNo: 'ST-9001', stmtDate: '2026-10-01', dueDate: '2026-10-25', prevBal: 0, newCharges: 20 },
    cycle: [
      { day: 1, event: 'First statement mailed', detail: 'Balance $20.00 — due in 25 days' },
      { day: 25, event: 'Due date', detail: 'No payment received yet' },
      { day: 30, event: 'Friendly reminder call', detail: 'Patient promises to pay this week' },
      { day: 37, event: 'Payment received', detail: 'Check for $20.00 — account closed' },
    ],
    tasks: [
      { q: 'From the EOB, what is the patient\u2019s responsibility?', answer: 20,
        why: 'PR-3 = $20 copay. The $50 contractual adjustment (CO-45) is never billed to the patient.' },
      { q: 'What is the total amount due on this statement?', answer: 20,
        why: 'Previous balance $0 + new charges $20 = $20.00 due.' },
    ],
    correctAction: 'send-statement',
    why: 'A simple copay balance. Send the statement, follow up once at 30 days, and the account resolves. Never send a $20 balance to collections — it costs more to collect than it\u2019s worth.',
  },
  {
    id: 'STMT-02', title: 'Deductible + coinsurance math', difficulty: 'Intermediate',
    patient: 'James Carter · PT-10007 · DOB 11/30/1972',
    dos: '2026-08-15', cpt: '20610 — Arthrocentesis, major joint',
    eob: { billed: 300, allowed: 250, paid: 150, carc: 'CO-45', prCode: 'PR-2', prAmt: 100, note: 'PR-1 $60 deductible + PR-2 $40 coinsurance (20% of remaining $200)' },
    statement: { stmtNo: 'ST-9002', stmtDate: '2026-09-01', dueDate: '2026-09-26', prevBal: 0, newCharges: 100 },
    cycle: [
      { day: 1, event: 'First statement mailed', detail: 'Balance $100.00 — deductible $60 + coinsurance $40' },
      { day: 30, event: 'Second statement — no payment', detail: 'Balance $100.00 — add \u201cplease call us\u201d message' },
      { day: 45, event: 'Patient calls — confused by bill', detail: 'Explain: deductible first, then 20% coinsurance on the rest' },
      { day: 50, event: 'Payment plan agreed', detail: '$50/month × 2 months — auto-draft set up' },
      { day: 80, event: 'Plan complete', detail: 'Account paid in full' },
    ],
    tasks: [
      { q: 'The EOB shows PR-1 $60 and PR-2 $40. What does the patient owe?', answer: 100,
        why: 'PR-1 (deductible) $60 + PR-2 (coinsurance) $40 = $100 patient responsibility. Allowed $250 − paid $150 = $100 unpaid.' },
      { q: 'Patient can pay $50/month. How many months to clear $100?', answer: 2,
        why: '$100 ÷ $50 = 2 months. Always confirm the plan in writing and set auto-draft.' },
    ],
    correctAction: 'payment-plan',
    why: 'A $100 balance with a willing patient is a payment-plan case, not a collections case. Two $50 payments resolve it cleanly.',
  },
  {
    id: 'STMT-03', title: 'Payment plan management', difficulty: 'Intermediate',
    patient: 'Linda Park · PT-10011 · DOB 03/22/1990',
    dos: '2026-07-10', cpt: '47562 — Laparoscopic cholecystectomy',
    eob: { billed: 8500, allowed: 6200, paid: 4960, carc: 'CO-45', prCode: 'PR-2', prAmt: 1240, note: '20% coinsurance on $6,200 allowed' },
    statement: { stmtNo: 'ST-9003', stmtDate: '2026-08-01', dueDate: '2026-08-26', prevBal: 0, newCharges: 1240 },
    cycle: [
      { day: 1, event: 'First statement mailed', detail: 'Balance $1,240.00' },
      { day: 30, event: 'Second statement', detail: 'No payment — balance $1,240.00' },
      { day: 40, event: 'Patient calls — cannot pay in full', detail: 'Financial counselor reviews income; qualifies for extended plan' },
      { day: 42, event: 'Payment plan: $103.34 × 12 months', detail: 'Written agreement signed; first draft scheduled' },
      { day: 200, event: 'Month 6 — payment missed', detail: 'Courtesy call; patient lost job; plan renegotiated to $62 × remaining' },
      { day: 380, event: 'Plan complete', detail: 'Full $1,240 collected over 12 months' },
    ],
    tasks: [
      { q: 'Patient owes $1,240. What is the monthly amount on a 12-month plan?', answer: 103.33,
        why: '$1,240 ÷ 12 = $103.33/month. Round the final payment to clear the balance exactly.' },
      { q: 'After 6 payments of $103.33, the patient misses month 7. What is the remaining balance?', answer: 620.02,
        why: '$1,240 − (6 × $103.33) = $620.02 remaining. Renegotiate — do not cancel the plan over one miss.' },
    ],
    correctAction: 'payment-plan',
    why: 'Large surgical balances need structured plans. One missed payment is a renegotiation trigger, not a collections trigger — persistence collected the full $1,240.',
  },
  {
    id: 'STMT-04', title: 'Disputed charge — investigate first', difficulty: 'Advanced',
    patient: 'Robert Chen · PT-10013 · DOB 06/05/1968',
    dos: '2026-06-20', cpt: '93000 — ECG, routine',
    eob: { billed: 85, allowed: 45, paid: 0, carc: 'CO-96', prCode: '', prAmt: 0, note: 'CO-96: non-covered — routine screening ECG' },
    statement: { stmtNo: 'ST-9004', stmtDate: '2026-07-15', dueDate: '2026-08-09', prevBal: 0, newCharges: 0 },
    cycle: [
      { day: 1, event: 'EOB received — $0 paid, CO-96', detail: 'Payer says routine ECG not covered' },
      { day: 5, event: 'Chart review', detail: 'ECG was ordered for chest pain workup — NOT routine screening' },
      { day: 6, event: 'Coding corrected', detail: 'DX updated to R07.9 (chest pain); claim corrected and resubmitted' },
      { day: 25, event: 'Corrected claim paid', detail: '$45 allowed, $36 paid, $9 coinsurance → patient billed $9' },
    ],
    tasks: [
      { q: 'The EOB denies the ECG as routine (CO-96) but the chart shows chest pain. What is the correct next step?', answer: 0,
        why: 'Investigate before billing. The coding was wrong — a corrected claim with the right diagnosis gets paid. Billing the patient for a coding error violates the No Surprises Act spirit and payer contracts.' },
    ],
    correctAction: 'investigate',
    why: 'Never bill the patient until you verify the denial is legitimate. Here the fix was a corrected claim — the patient only owed $9 coinsurance, not $85.',
  },
  {
    id: 'STMT-05', title: 'Bad debt write-off decision', difficulty: 'Advanced',
    patient: 'Uninsured self-pay · PT-10021 · DOB 01/12/1980',
    dos: '2026-03-01', cpt: '99214 — Office visit, moderate complexity',
    eob: null,
    statement: { stmtNo: 'ST-9005', stmtDate: '2026-04-01', dueDate: '2026-04-26', prevBal: 0, newCharges: 200, note: 'Self-pay — Good Faith Estimate was $180' },
    cycle: [
      { day: 1, event: 'First statement — $200', detail: 'Self-pay balance; GFE was $180' },
      { day: 30, event: 'Second statement', detail: 'No payment' },
      { day: 60, event: 'Third statement + call', detail: 'Patient unreachable — phone disconnected' },
      { day: 90, event: 'Final notice', detail: 'No response — skip-trace finds no new address' },
      { day: 120, event: 'Sent to collections', detail: 'External agency takes 25% contingency' },
      { day: 210, event: 'Agency returns uncollected', detail: 'Patient judgment-proof — recommend bad debt write-off' },
      { day: 215, event: 'Manager approval → bad debt', detail: '$200 written off; account closed' },
    ],
    tasks: [
      { q: 'The Good Faith Estimate was $180 but the bill is $200. By how much can the bill exceed the GFE before the patient can dispute?', answer: 400,
        why: 'Under the No Surprises Act, a self-pay patient can dispute any bill that exceeds the Good Faith Estimate by $400 or more. Here $200 − $180 = $20 — well within the limit.' },
      { q: 'After collections fails, what approval is needed for a bad debt write-off?', answer: 0,
        why: 'Write-offs above the staff threshold need manager/supervisor approval. Document every collection attempt — auditors check the trail.' },
    ],
    correctAction: 'write-off',
    why: 'Every step was exhausted: 4 statements, calls, skip-trace, external collections. A documented bad-debt write-off with manager approval is the correct, compliant close.',
  },
];

const STATEMENT_ACTIONS = [
  { v: 'send-statement', t: 'Send statement — routine billing cycle' },
  { v: 'payment-plan', t: 'Set up a payment plan' },
  { v: 'investigate', t: 'Investigate before billing the patient' },
  { v: 'collections', t: 'Send to external collections (120+ days)' },
  { v: 'write-off', t: 'Bad-debt write-off (needs approval)' },
  { v: 'hardship', t: 'Hardship discount / financial assistance' },
];

const FDCPA_RULES = [
  { rule: 'Call hours', ok: 'Calls only between 8 AM and 9 PM (patient\u2019s local time)', bad: 'Calling at 6 AM or 11 PM' },
  { rule: 'Workplace', ok: 'Stop calling at work if the patient says so', bad: 'Calling the employer after being told to stop' },
  { rule: 'Third parties', ok: 'Only contact spouse, parent (minor), or attorney', bad: 'Telling neighbors or coworkers about the debt' },
  { rule: 'Harassment', ok: 'Professional, factual communication', bad: 'Threats, profanity, repeated calls to annoy' },
  { rule: 'Validation', ok: 'Send written validation notice within 5 days of first contact', bad: 'Demanding payment with no written proof of debt' },
  { rule: 'Disputes', ok: 'Pause collection on disputed portion until verified', bad: 'Continuing to collect a disputed debt' },
];


// ===== UB-04 INSTITUTIONAL CLAIMS scenarios =====
// Each scenario is a realistic hospital/facility encounter to build on the UB-04.
const UB04 = [
  {
    id: 'UB-01', title: 'Inpatient stay — pneumonia', difficulty: 'Beginner',
    setting: 'Patient: Robert Hayes, 68yo M. Admitted 2026-03-02 with community-acquired pneumonia, discharged 2026-03-06 (4 days).',
    fields: [
      { fl: '4', label: 'Type of Bill', hint: '1st digit=type of facility, 2nd=type of care, 3rd=frequency', answer: '111', options: ['111', '131', '121', '141'] },
      { fl: '42', label: 'Revenue Code — Room & Board', hint: 'Room and board, semi-private, 2-bed', answer: '0120', options: ['0120', '0450', '0360', '0272'] },
      { fl: '42', label: 'Revenue Code — Pharmacy', hint: 'General pharmacy drugs', answer: '0250', options: ['0250', '0300', '0320', '0270'] },
      { fl: '42', label: 'Revenue Code — Lab', hint: 'General laboratory', answer: '0300', options: ['0300', '0450', '0710', '0272'] },
      { fl: '67', label: 'Principal Diagnosis (ICD-10)', hint: 'Community-acquired pneumonia, unspecified organism', answer: 'J18.9', options: ['J18.9', 'J18.1', 'J12.9', 'R05'] },
      { fl: '76', label: 'Admitting Diagnosis', hint: 'Same as principal for this case', answer: 'J18.9', options: ['J18.9', 'Z00.6', 'R06.02', 'J18.1'] },
    ],
    explain: 'Inpatient hospital claims use Type of Bill 11x (hospital inpatient). Room & board is 012x, pharmacy 025x, lab 030x. Principal diagnosis J18.9 drives the DRG.',
  },
  {
    id: 'UB-02', title: 'Outpatient surgery — knee arthroscopy', difficulty: 'Intermediate',
    setting: 'Patient: Lisa Morgan, 42yo F. Outpatient arthroscopic knee surgery 2026-04-15, discharged same day.',
    fields: [
      { fl: '4', label: 'Type of Bill', hint: 'Hospital outpatient', answer: '131', options: ['111', '131', '141', '121'] },
      { fl: '42', label: 'Revenue Code — Operating Room', hint: 'OR services', answer: '0360', options: ['0360', '0450', '0510', '0120'] },
      { fl: '42', label: 'Revenue Code — Recovery Room', hint: 'Post-anesthesia recovery', answer: '0710', options: ['0710', '0120', '0250', '0300'] },
      { fl: '44', label: 'HCPCS — Arthroscopy code', hint: 'Knee arthroscopy with meniscectomy', answer: '29881', options: ['29881', '29880', '29877', '27570'] },
      { fl: '67', label: 'Principal Diagnosis', hint: 'Bucket-handle tear of medial meniscus', answer: 'S83.211A', options: ['S83.211A', 'M23.203', 'S83.209A', 'M23.8X9'] },
    ],
    explain: 'Outpatient hospital = TOB 13x. OR is revenue 0360, recovery 0710. On UB-04, procedures go in FL44 with HCPCS; the 13x bill type tells the payer this is outpatient so no DRG applies.',
  },
  {
    id: 'UB-03', title: 'Emergency department visit', difficulty: 'Intermediate',
    setting: 'Patient: James Carter, 55yo M. ED visit 2026-05-01 for chest pain, ruled out MI, discharged home.',
    fields: [
      { fl: '4', label: 'Type of Bill', hint: 'Hospital outpatient (ED is outpatient)', answer: '131', options: ['111', '131', '141', '121'] },
      { fl: '42', label: 'Revenue Code — Emergency Room', hint: 'General ER services', answer: '0450', options: ['0450', '0510', '0360', '0120'] },
      { fl: '42', label: 'Revenue Code — CT Scan', hint: 'CT scan, general', answer: '0350', options: ['0350', '0320', '0300', '0400'] },
      { fl: '44', label: 'HCPCS — ED visit level', hint: 'ED visit, moderate complexity MDM', answer: '99284', options: ['99281', '99283', '99284', '99285'] },
      { fl: '67', label: 'Principal Diagnosis', hint: 'Chest pain, unspecified (ruled-out MI — code the symptom)', answer: 'R07.9', options: ['R07.9', 'I21.9', 'R07.89', 'Z03.89'] },
    ],
    explain: 'ED = outpatient TOB 13x even though the patient came by ambulance. Revenue 0450 = ER. Ruled-out conditions are NOT coded — code the presenting symptom R07.9.',
  },
  {
    id: 'UB-04', title: 'Observation stay — syncope', difficulty: 'Advanced',
    setting: 'Patient: Nancy Wells, 71yo F. Placed in observation 2026-06-10 for syncope workup, discharged 2026-06-11 (<48h).',
    fields: [
      { fl: '4', label: 'Type of Bill', hint: 'Hospital outpatient — observation is billed as outpatient', answer: '131', options: ['111', '131', '121', '141'] },
      { fl: '42', label: 'Revenue Code — Observation', hint: 'Observation room services (per hour)', answer: '0762', options: ['0762', '0120', '0450', '0510'] },
      { fl: '44', label: 'HCPCS — Observation per hour', hint: 'G-code for observation, per hour', answer: 'G0378', options: ['G0378', 'G0379', '99218', '99234'] },
      { fl: '67', label: 'Principal Diagnosis', hint: 'Syncope', answer: 'R55', options: ['R55', 'I95.1', 'R42', 'Z03.89'] },
      { fl: '14', label: 'Admission Type', hint: 'Observation is not an inpatient admission', answer: '1', options: ['1', '2', '3', '9'] },
    ],
    explain: 'Observation <48h = outpatient TOB 13x with revenue 0762 + G0378 per hour. If it crosses to inpatient, the TOB flips to 11x — a classic audit target.',
  },
  {
    id: 'UB-05', title: 'Skilled nursing facility stay', difficulty: 'Advanced',
    setting: 'Patient: Thomas Reed, 79yo M. SNF stay 2026-07-01 to 2026-07-20 following hip replacement.',
    fields: [
      { fl: '4', label: 'Type of Bill', hint: 'SNF inpatient', answer: '211', options: ['111', '211', '131', '121'] },
      { fl: '42', label: 'Revenue Code — SNF room', hint: 'Skilled nursing room & board', answer: '0190', options: ['0190', '0120', '0550', '0580'] },
      { fl: '42', label: 'Revenue Code — Physical therapy', hint: 'PT services', answer: '0420', options: ['0420', '0430', '0440', '0550'] },
      { fl: '67', label: 'Principal Diagnosis', hint: 'Aftercare following joint replacement', answer: 'Z47.1', options: ['Z47.1', 'S72.001A', 'M16.11', 'Z96.641'] },
    ],
    explain: 'SNF = TOB 21x (2 = SNF). Aftercare Z-codes are principal when the patient is admitted for rehab/aftercare, not the original fracture.',
  },
];

// ===== NCCI code pairs =====
// indicator: 0 = never together, 1 = together only with qualifying modifier, 9 = no edit
const NCCI_PAIRS = [
  { c1: '99213', c2: '36415', ind: 1, modifier: '59 or XS', why: 'Venipuncture (36415) is bundled into the E/M (99213) unless it is a distinct service — append 59/XS to 36415 only if separately reportable.' },
  { c1: '52648', c2: '52281', ind: 0, modifier: 'none — drop one', why: 'Indicator 0: these can never be reported together on the same day. No modifier overrides this edit.' },
  { c1: '10005', c2: '76942', ind: 9, modifier: 'none — inherent', why: 'TRAP: 10005 (FNA) has ultrasound guidance built in. 76942 is never separately reportable with it — delete 76942, no NCCI pair exists.' },
  { c1: '11100', c2: '11101', ind: 1, modifier: '59 or XS', why: 'Each additional lesion biopsy (11101) needs 59/XS when done at the same session as the first (11100) to show distinct lesions.' },
  { c1: '99213', c2: '20610', ind: 9, modifier: '25 on the E/M', why: 'No NCCI edit between E/M and joint injection — but 20610 needs a separately documented evaluation, so append -25 to 99213 (never -59 on E/M).' },
  { c1: '29881', c2: '29877', ind: 1, modifier: '59 or XS', why: 'Chondroplasty (29877) at a separate compartment from the meniscectomy (29881) can take 59/XS; same compartment = bundled.' },
  { c1: '93000', c2: '93010', ind: 0, modifier: 'none — drop one', why: '93000 is the global ECG; 93010 is the interpretation component. Billing both = unbundling, indicator 0.' },
  { c1: '47562', c2: '47563', ind: 0, modifier: 'none — pick one', why: 'Laparoscopic cholecystectomy (47562) vs with cholangiography (47563) — mutually exclusive, pick the one actually performed.' },
  { c1: '99214', c2: '96372', ind: 1, modifier: '59 or XS', why: 'Therapeutic injection (96372) bundled into E/M unless separate encounter/service — 59/XS on 96372 if distinct.' },
  { c1: '20552', c2: '20553', ind: 0, modifier: 'none — pick one', why: 'Trigger point injections: 20552 (1-2 muscles) vs 20553 (3+ muscles) — code one based on muscle count, never both.' },
  { c1: '11042', c2: '11043', ind: 0, modifier: 'none — pick one', why: 'Debridement codes are depth-specific per session; report the deepest level only.' },
  { c1: '64483', c2: '64484', ind: 1, modifier: 'none needed — add-on', why: '64484 is an add-on code (each additional level) — it is designed to pair with 64483, no modifier needed.' },
  { c1: '95811', c2: '95811-26', ind: 0, modifier: 'none — split components', why: 'Cannot bill global 95811 plus the professional component 95811-26 — bill 26 + TC separately, or global alone.' },
  { c1: '70450', c2: '70450-26', ind: 0, modifier: 'none — split components', why: 'Same as above: global vs professional component of the same CT — mutually exclusive.' },
  { c1: '12001', c2: '12002', ind: 0, modifier: 'none — sum lengths', why: 'Simple repairs: add the wound lengths together and pick ONE code for the total — never stack repair codes.' },
  { c1: '17000', c2: '17003', ind: 1, modifier: 'none needed — add-on', why: '17003 is the add-on for each additional lesion beyond the first — pairs with 17000 by design.' },
  { c1: '97110', c2: '97112', ind: 1, modifier: '59 or XP', why: 'Therapeutic exercises (97110) and neuromuscular re-ed (97112) need 59/XP on the second if distinct timed interventions in the same visit.' },
  { c1: 'G0438', c2: 'G0439', ind: 0, modifier: 'none — pick one', why: 'Initial (G0438) vs subsequent (G0439) annual wellness visit — one per patient per year cycle, never together.' },
  { c1: '80053', c2: '80048', ind: 1, modifier: 'none — panel rule', why: 'Comprehensive metabolic panel (80053) INCLUDES the basic panel (80048) components — do not bill both; the panel code wins.' },
  { c1: '27447', c2: '27446', ind: 0, modifier: 'none — pick one', why: 'Total knee arthroplasty (27447) vs partial (27446) — mutually exclusive procedures.' },
  { c1: '43239', c2: '43235', ind: 1, modifier: '59 or XS', why: 'EGD with biopsy (43239) includes diagnostic EGD (43235) — only separable with 59/XS for a truly distinct second endoscopy.' },
  { c1: 'J1956', c2: '96377', ind: 9, modifier: 'none needed', why: 'Drug (J1956) + IV push admin (96377) — no NCCI edit; report drug units AND the administration code.' },
];


// ===== CREDENTIALING TRACKER scenarios =====
// Provider enrollment workflow simulator. Each scenario is a mock provider the
// trainee must move through enrollment: NPI -> CAQH -> Medicare (PECOS) ->
// Medicaid -> commercial payer contracts. Realistic timeframes, document
// checklists, and the classic failure modes (expired license, revalidation,
// payer rejection).
const CRED = [
  {
    id: 'CRED-01', title: 'New physician — full enrollment from scratch', difficulty: 'Beginner',
    provider: 'Dr. Sarah Chen, MD', specialty: 'Family Medicine',
    situation: 'Just finished residency. No NPI, no enrollments. Start date at the practice: 90 days from today.',
    steps: [
      { step: 'NPI Application (NPPES)', timeframe: 'Up to 10 business days', status: 'not-started',
        docs: ['SSN or ITIN', 'State license number', 'Practice address', 'Taxonomy code (207Q00000X — Family Medicine)'] },
      { step: 'CAQH ProView profile', timeframe: '2–4 weeks (attestation)', status: 'locked',
        docs: ['NPI (from step 1)', 'DEA certificate', 'Malpractice insurance face sheet', 'Work history 5 years', 'Hospital privileges'] },
      { step: 'Medicare enrollment (PECOS)', timeframe: '60–90 days', status: 'locked',
        docs: ['NPI', 'State license', 'DEA', 'Practice location + hours', 'EFT/banking info', 'Adverse action disclosures'] },
      { step: 'State Medicaid enrollment', timeframe: '30–90 days (state varies)', status: 'locked',
        docs: ['NPI', 'Medicare enrollment (many states require it first)', 'State license', 'CLIA (if lab services)'] },
      { step: 'Commercial payer contracts', timeframe: '90–120 days per payer', status: 'locked',
        docs: ['CAQH ID (payers pull from CAQH)', 'NPI', 'W-9', 'Malpractice face sheet', 'Signed contract + fee schedule'] },
    ],
    decisions: [
      { q: 'Dr. Chen starts in 90 days. What is the FIRST enrollment step, and why can nothing else start without it?',
        options: [
          'NPI application — every downstream enrollment (CAQH, PECOS, Medicaid, commercial) requires the NPI',
          'CAQH profile — payers need it first, NPI can wait',
          'Commercial contracts — they take the longest, so start there',
          'Medicare PECOS — federal enrollment drives everything else',
        ], answer: 0, points: 20,
        explanation: 'The NPI is the universal provider identifier — CAQH, PECOS, Medicaid, and every commercial payer require it. NPPES issues it in ~10 business days, so it is always step one.',
        hint: 'Which identifier does every other application ask for?' },
      { q: 'NPI received. The practice wants Dr. Chen credentialed with 4 commercial payers ASAP. What is the most efficient next move?',
        options: [
          'Apply to each payer separately with paper applications',
          'Complete the CAQH ProView profile and attest it — payers pull credentialing data from CAQH',
          'Wait for Medicare approval first — commercial payers will not look at her until then',
          'Start seeing patients and bill under another physician\'s NPI',
        ], answer: 1, points: 20,
        explanation: 'CAQH ProView is the industry-standard credentialing clearinghouse — most commercial payers pull from it instead of taking separate applications. One complete, attested CAQH profile feeds all 4 payer applications. (Billing under another physician\'s NPI without proper incident-to/locum rules is fraud.)',
        hint: 'There is one profile that feeds many payers.' },
      { q: 'A payer asks for Dr. Chen\'s CAQH attestation date. Why does the attestation date matter?',
        options: [
          'It does not — payers only check the NPI',
          'Attestations expire every 120 days; an expired attestation stalls credentialing until re-attested',
          'It sets her fee schedule rates',
          'It is only needed for Medicare, not commercial payers',
        ], answer: 1, points: 20,
        explanation: 'CAQH requires re-attestation every 120 days. An expired attestation is one of the most common silent credentialing delays — the payer\'s pull returns stale data and the file sits in limbo until someone re-attests.',
        hint: 'What happens to a CAQH profile after 120 days?' },
      { q: 'Day 75: Medicare PECOS is still pending, but two commercial payers approved her. Can Dr. Chen see Medicare patients on her start date (day 90)?',
        options: [
          'Yes — commercial approval covers Medicare too',
          'Yes, as long as she has an NPI',
          'No — she cannot bill Medicare until PECOS enrollment is effective; seeing Medicare patients now means the services are non-billable',
          'No, but she can bill Medicare retroactively for up to 12 months',
        ], answer: 2, points: 20,
        explanation: 'Medicare requires an effective PECOS enrollment before services are billable (retroactive billing is limited to 30 days prior to the effective date for most enrollments, not 12 months). Commercial approvals do not transfer to Medicare.',
        hint: 'Does a commercial contract enroll you in Medicare?' },
      { q: 'Which document is required for Medicare PECOS but is NOT typically required for a commercial payer application?',
        options: [
          'State medical license',
          'W-9',
          'Electronic Funds Transfer (EFT) authorization for Medicare payments',
          'Malpractice insurance face sheet',
        ], answer: 2, points: 20,
        explanation: 'PECOS requires EFT/banking information because Medicare pays electronically by default and ties it to enrollment. Commercial payers use the W-9 for tax reporting instead; EFT setup with each commercial payer happens after contracting, not during credentialing.',
        hint: 'How does Medicare send the money?' },
    ],
  },
  {
    id: 'CRED-02', title: 'Medicare revalidation due — Dr. James Rodriguez', difficulty: 'Intermediate',
    provider: 'Dr. James Rodriguez, MD', specialty: 'Cardiology',
    situation: 'Enrolled in Medicare since 2019. MAC sent a revalidation notice: respond within 90 days or enrollment is deactivated.',
    steps: [
      { step: 'Revalidation notice received (MAC letter)', timeframe: 'Day 0 — 90-day clock starts', status: 'done',
        docs: ['MAC revalidation letter (keep on file)'] },
      { step: 'Update PECOS record', timeframe: 'Complete within 60 days (buffer)', status: 'not-started',
        docs: ['Current state license', 'DEA (if prescribing)', 'Practice location verification', 'Adverse actions since last enrollment'] },
      { step: 'Re-attest CAQH (if used by payers)', timeframe: 'Same window', status: 'not-started',
        docs: ['Updated malpractice face sheet', 'New hospital privileges (if any)'] },
      { step: 'Confirm continued enrollment', timeframe: 'MAC processes in 30–60 days', status: 'locked',
        docs: ['PECOS confirmation letter'] },
    ],
    decisions: [
      { q: 'How often does Medicare require physicians to revalidate enrollment?',
        options: [ 'Every year', 'Every 3 years', 'Every 5 years', 'Only once — enrollment never expires' ],
        answer: 2, points: 25,
        explanation: 'Medicare revalidation is every 5 years (CMS sends the notice; some MACs also do off-cycle revalidations). Missing the 90-day response window deactivates enrollment.',
        hint: 'Think in half-decades.' },
      { q: 'Dr. Rodriguez ignores the letter. Day 95: his Medicare enrollment is deactivated. A claim for a service on day 100 is submitted. What happens?',
        options: [
          'It pays normally — deactivation only affects new enrollments',
          'It denies — deactivated providers cannot bill Medicare; claims reject until enrollment is reactivated',
          'It pays at a 2% penalty for 6 months',
          'It is automatically held and paid once he revalidates',
        ], answer: 1, points: 25,
        explanation: 'Deactivation = no billing privileges. Claims with dates of service during deactivation deny; there is no auto-hold-and-pay. Reactivation requires a new application and the gap dates are generally not billable.',
        hint: 'Can you bill a payer you are not enrolled with?' },
      { q: 'While updating PECOS, you discover his state license renewed last month but the PECOS record shows the old expiry. What is the risk if you submit revalidation without fixing it?',
        options: [
          'No risk — PECOS syncs automatically with state boards',
          'The application can be rejected or delayed for a licensure discrepancy; always update license data first',
          'Only a problem if the license actually expired',
          'Medicare does not verify state licenses',
        ], answer: 1, points: 25,
        explanation: 'PECOS validates licensure against state data. A mismatch triggers development (requests for information) or rejection, burning weeks off the 90-day clock. Update the license in PECOS before submitting.',
        hint: 'Do enrollment systems trust you, or verify?' },
      { q: 'Best practice for the 90-day revalidation window?',
        options: [
          'Wait until day 85 — the MAC sends reminders',
          'Submit within the first 60 days, keeping a 30-day buffer for MAC development requests',
          'Revalidation is optional if the provider has no adverse actions',
          'Have the provider re-enroll as a new applicant instead — it is faster',
        ], answer: 1, points: 25,
        explanation: 'MACs routinely issue development requests (missing documents, clarifications) that eat 2–4 weeks. Submitting by day 60 leaves a buffer so a development cycle does not push past day 90 into deactivation.',
        hint: 'What happens when the MAC asks for one more document?' },
    ],
  },
  {
    id: 'CRED-03', title: 'Expired license + payer rejection — Dr. Priya Patel', difficulty: 'Advanced',
    provider: 'Dr. Priya Patel, DO', specialty: 'Orthopedic Surgery',
    situation: 'Commercial payer rejected her credentialing application. Investigation shows her state license lapsed 45 days ago (renewal missed during maternity leave). Two problems to solve at once.',
    steps: [
      { step: 'Reinstate state license', timeframe: '2–6 weeks (state board)', status: 'not-started',
        docs: ['Renewal application + late fees', 'CME proof', 'NPDB self-query'] },
      { step: 'Update CAQH + NPI record (NPPES)', timeframe: '1–2 weeks after license', status: 'locked',
        docs: ['Reinstated license number/expiry'] },
      { step: 'Notify enrolled payers of the gap', timeframe: 'Immediately', status: 'not-started',
        docs: ['Gap explanation letter', 'Reinstated license copy'] },
      { step: 'Re-apply to rejecting payer', timeframe: '90–120 days', status: 'locked',
        docs: ['Full credentialing packet', 'Explanation of the lapse', 'Clean NPDB report'] },
    ],
    decisions: [
      { q: 'The payer rejection letter cites "licensure not in good standing." What is the FIRST thing to fix?',
        options: [
          'Appeal the payer rejection immediately',
          'Reinstate the state license — no payer will credential a provider without an active, unrestricted license',
          'Apply to a different payer that might not check',
          'Have her practice under a collaborating physician\'s license',
        ], answer: 1, points: 20,
        explanation: 'An active, unrestricted state license is the non-negotiable foundation of credentialing. Appeals and new applications are pointless until the license is reinstated — every payer verifies licensure first.',
        hint: 'What does every credentialing file check before anything else?' },
      { q: 'Her license lapsed 45 days ago and she saw patients during the gap. What is the billing compliance risk?',
        options: [
          'None — the license is reinstated now, so the gap is forgiven',
          'Services during an unlicensed gap are generally non-billable and may need to be written off; billing them can be a compliance violation',
          'Only the first 30 days are a problem; day 31–45 is a grace period',
          'Bill them to the secondary payer instead',
        ], answer: 1, points: 20,
        explanation: 'Practicing on a lapsed license can void billing privileges for those dates of service. Most compliance policies require writing off gap-date services; billing them risks overpayment liability and, in egregious cases, fraud exposure.',
        hint: 'Were those services legally billable on those dates?' },
      { q: 'She is enrolled with Medicare (PECOS) from before the lapse. Must Medicare be notified of the license gap?',
        options: [
          'No — Medicare only cares at revalidation',
          'Yes — PECOS requires reporting adverse licensure actions; failure to report can lead to revocation',
          'Only if a claim denied',
          'Only the state board needs to know',
        ], answer: 1, points: 20,
        explanation: 'Medicare enrollment rules require reporting final adverse actions (including licensure suspensions/lapses) within 30 days. Silence can convert a fixable lapse into a revocation with a re-enrollment bar.',
        hint: 'Does Medicare want to hear about licensure problems promptly?' },
      { q: 'Re-applying to the rejecting payer: what most improves the odds of approval?',
        options: [
          'Re-submit the identical application — reviewers change',
          'A complete packet: reinstated license, clean NPDB self-query, gap explanation letter, and proof of current malpractice — addressing the exact rejection reason',
          'Offer to accept 20% lower rates',
          'Wait 12 months before re-applying',
        ], answer: 1, points: 20,
        explanation: 'Payers re-evaluate on evidence. A packet that directly answers the rejection reason (license now active, NPDB clean, gap explained with remediation) is what credentialing committees approve. Discounts and waiting do not fix the file.',
        hint: 'What would convince a committee the problem is solved?' },
      { q: 'Prevention: what single process would have caught the expiring license before the lapse?',
        options: [
          'Relying on the provider to remember',
          'An expirables tracking log (license, DEA, malpractice, board certs) with 90/60/30-day alerts owned by the credentialing team',
          'Checking once a year at revalidation',
          'Nothing — lapses are unavoidable',
        ], answer: 1, points: 20,
        explanation: 'Credentialing teams run an expirables dashboard with tiered alerts (90/60/30 days). It is the standard control that prevents exactly this failure mode — licenses, DEA registrations, malpractice, and certifications all tracked in one place.',
        hint: 'How do practices track dozens of expiring documents?' },
    ],
  },
];
const CRED_STEPS_INFO = [
  { step: 'NPI (NPPES)', time: '~10 business days', note: 'Always first — every downstream enrollment needs it.' },
  { step: 'CAQH ProView', time: '2–4 weeks', note: 'Re-attest every 120 days or files stall.' },
  { step: 'Medicare (PECOS)', time: '60–90 days', note: 'Revalidate every 5 years; 90-day response window.' },
  { step: 'Medicaid (state)', time: '30–90 days', note: 'Many states require Medicare enrollment first.' },
  { step: 'Commercial contracts', time: '90–120 days each', note: 'Payers pull from CAQH; parallel-track them.' },
];


// ---- Prior Authorization Workflow Lab (fictional) ----
// Real timelines per CMS-0057-F: urgent = 72 hours, standard = 7 calendar days.
const PRIOR_AUTH = [
  {
    id: 'PA-01', title: 'MRI Lumbar Spine — Clean Approval', difficulty: 'Beginner',
    payer: 'Aetna (Simulated)',
    snapshot: [
      ['Patient', 'PT-10021 · 52yo F, low back pain x6 weeks, radiculopathy'],
      ['Service', 'MRI lumbar spine without contrast'],
      ['CPT', '72148'], ['ICD-10', 'M54.16 — Radiculopathy, lumbar region'],
      ['Urgency', 'Standard (non-urgent)'], ['Ordering NPI', '1234567890'],
    ],
    clinical: 'Conservative therapy (PT x6 weeks + NSAIDs) failed. Neuro exam: diminished Achilles reflex, positive straight-leg raise at 40°. No red flags.',
    steps: [
      { q: 'Step 1 — Submit: which urgency level and submission channel are correct?',
        options: ['Urgent (72-hr) via phone — back pain is always urgent', 'Standard (7-day) via payer portal with clinical notes attached', 'Standard via fax with no notes — the CPT is enough', 'Skip prior auth — MRIs never need it'],
        answer: 1, points: 10,
        explanation: 'Non-urgent MRI = standard 7-day review via portal. Clinical notes proving failed conservative therapy are required — CPT alone never suffices.',
        hint: 'CMS-0057-F: urgent = 72 hrs, standard = 7 days. Is this urgent?' },
      { q: 'Step 2 — Day 5 status check shows "Approved". What must you do before the claim goes out?',
        options: ['Nothing — approval is automatic on the claim', 'Record the authorization number and verify it matches the CPT billed', 'Call the patient to collect the copay first', 'Resubmit the auth request to be safe'],
        answer: 1, points: 10,
        explanation: 'The auth number must be on the claim and must match the billed CPT. A mismatch = CO-15 denial (auth number missing/invalid).',
        hint: 'What links the approval to the claim?' },
      { q: 'Step 3 — The claim is submitted with auth #PA-88412 for CPT 72148. It pays. What closes the loop?',
        options: ['File the approval letter with the patient record and post payment', 'Delete the auth request — it is no longer needed', 'Appeal the approval', 'Bill the patient the full charge'],
        answer: 0, points: 10,
        explanation: 'Keep the approval on file (audits!), post the payment per the ERA. Authorization is not a payment guarantee — always reconcile.',
        hint: 'Think audit trail.' },
    ],
  },
  {
    id: 'PA-02', title: 'Knee Arthroscopy — Pended, Then Approved', difficulty: 'Intermediate',
    payer: 'UnitedHealthcare (Simulated)',
    snapshot: [
      ['Patient', 'PT-10033 · 47yo M, chronic knee pain, failed injections'],
      ['Service', 'Knee arthroscopy with meniscectomy'],
      ['CPT', '29881'], ['ICD-10', 'M23.22 — Derangement of posterior horn of medial meniscus'],
      ['Urgency', 'Standard'], ['Ordering NPI', '1234567891'],
    ],
    clinical: 'MRI shows complex meniscal tear. Two corticosteroid injections failed. Surgeon recommends arthroscopic partial meniscectomy.',
    steps: [
      { q: 'Step 1 — Submit: the portal asks for supporting documents. What do you attach?',
        options: ['Only the operative plan — surgery speaks for itself', 'MRI report + injection records + office notes showing failed conservative care', 'The patient insurance card copy', 'Nothing — UHC approves all arthroscopies'],
        answer: 1, points: 10,
        explanation: 'Payers require objective evidence: MRI confirming the tear + documented failed conservative treatment. Missing records = pended or denied.',
        hint: 'What proves medical necessity?' },
      { q: 'Step 2 — Day 4 status: "Pended — additional clinical information needed." Correct action?',
        options: ['Wait — pending always resolves itself', 'Submit the missing MRI report and office notes the same day, then re-check status', 'Cancel and resubmit a new request', 'Call the patient and tell them surgery is denied'],
        answer: 1, points: 10,
        explanation: '"Pended" is not a denial — it is a request for more info. Respond fast with exactly what was asked; the 7-day clock keeps running.',
        hint: 'Pended is not denied. What does the payer actually want?' },
      { q: 'Step 3 — Day 6: "Approved", auth #PA-90177 for CPT 29881. The surgeon also does a chondroplasty (29877) during the case. What now?',
        options: ['Bill both — the auth covers the whole surgery', 'Bill only 29881; 29877 needs its own auth or a post-service appeal with op notes', 'Drop 29881 and bill 29877 instead', 'Add modifier -59 to 29877 and bill it'],
        answer: 1, points: 10,
        explanation: 'Auth is CPT-specific. An unlisted-at-auth procedure needs separate authorization (or retro review). Billing it under the 29881 auth = CO-197/CO-15.',
        hint: 'Does the auth number know about 29877?' },
    ],
  },
  {
    id: 'PA-03', title: 'Specialty Drug — Denied, Step Therapy Required', difficulty: 'Advanced',
    payer: 'Cigna (Simulated)',
    snapshot: [
      ['Patient', 'PT-10044 · 38yo F, rheumatoid arthritis'],
      ['Service', 'Adalimumab (Humira) — specialty injectable'],
      ['HCPCS', 'J0135 (per 20 mg)'], ['ICD-10', 'M05.79 — Rheumatoid arthritis with rheumatoid factor'],
      ['Urgency', 'Standard'], ['Ordering NPI', '1234567892'],
    ],
    clinical: 'Rheumatologist prescribes adalimumab after methotrexate intolerance. No prior biologic tried.',
    steps: [
      { q: 'Step 1 — Submit: Cigna policy requires step therapy. What must the request demonstrate?',
        options: ['That the drug is FDA-approved — that is enough', 'Failure, intolerance, or contraindication of preferred step-1 agents (e.g., methotrexate)', 'The patient income level', 'That the physician prefers this brand'],
        answer: 1, points: 10,
        explanation: 'Step therapy = try cheaper/preferred drugs first. The request must document why step-1 agents failed or cannot be used.',
        hint: 'What does "step therapy" literally mean?' },
      { q: 'Step 2 — Decision: "Denied — step therapy not satisfied (CO-197)." Best next step?',
        options: ['Write it off — denials are final', 'Request peer-to-peer review: physician discusses the methotrexate intolerance with the payer medical director', 'Resubmit the identical request tomorrow', 'Bill the patient the full drug cost'],
        answer: 1, points: 10,
        explanation: 'Peer-to-peer is the fastest path on a clinical denial: the ordering physician defends medical necessity directly. Document the call (name, date, outcome).',
        hint: 'Who can argue clinical necessity best?' },
      { q: 'Step 3 — Peer-to-peer succeeds; auth #PA-91502 issued. The claim must show what to avoid CO-15?',
        options: ['The drug NDC number only', 'The auth number matching the HCPCS billed, plus correct units for J0135', 'The physician DEA number', 'Nothing extra — approval auto-links'],
        answer: 1, points: 10,
        explanation: 'J-codes bill per unit (J0135 = per 20 mg): units must match the administered dose, and the auth number must be on the claim.',
        hint: 'Two things must be exactly right on a drug claim.' },
    ],
  },
  {
    id: 'PA-04', title: 'Physical Therapy — Partial Approval', difficulty: 'Intermediate',
    payer: 'BCBS (Simulated)',
    snapshot: [
      ['Patient', 'PT-10055 · 61yo M, post-stroke rehab'],
      ['Service', 'Outpatient physical therapy'],
      ['CPT', '97110, 97140'], ['ICD-10', 'I69.351 — Hemiplegia following cerebral infarction'],
      ['Urgency', 'Standard'], ['Ordering NPI', '1234567893'],
    ],
    clinical: 'PT plan of care: 12 visits over 6 weeks for gait training and therapeutic exercise post-stroke.',
    steps: [
      { q: 'Step 1 — Submit: what makes a therapy auth request complete?',
        options: ['CPT codes and visit count', 'Plan of care with measurable goals, frequency, duration + physician order', 'The therapist license number', 'Patient preferred appointment times'],
        answer: 1, points: 10,
        explanation: 'Therapy auths require the plan of care: diagnosis, measurable goals, frequency/duration, and a signed physician order.',
        hint: 'What proves the therapy is skilled and necessary?' },
      { q: 'Step 2 — Decision: "Approved — 6 visits (not 12)." What is the correct handling?',
        options: ['Provide all 12 — the patient needs them', 'Provide 6, document progress, then request re-authorization with updated notes before visit 7', 'Appeal immediately before providing any visits', 'Bill 12 visits under the 6-visit auth'],
        answer: 1, points: 10,
        explanation: 'Partial approval = work within it. Provide the 6, show measurable progress, then re-auth with fresh documentation. Billing beyond the auth = denied.',
        hint: 'How do you earn the next 6?' },
      { q: 'Step 3 — After 6 visits the patient improved (gait speed +30%). Re-auth request should include?',
        options: ['The original plan of care, unchanged', 'Updated progress notes with objective measurements + revised goals for visits 7-12', 'A letter from the patient', 'A new diagnosis code'],
        answer: 1, points: 10,
        explanation: 'Re-auth lives or dies on objective progress + continued medical necessity. Same paperwork resubmitted = same partial answer.',
        hint: 'What is new since the first request?' },
    ],
  },
  {
    id: 'PA-05', title: 'DME — Denied, Not Medically Necessary', difficulty: 'Advanced',
    payer: 'Medicare (Simulated)',
    snapshot: [
      ['Patient', 'PT-10066 · 72yo M, mild low back ache'],
      ['Service', 'Lumbar back brace (custom fitted)'],
      ['HCPCS', 'L0631'], ['ICD-10', 'M54.5 — Low back pain'],
      ['Urgency', 'Standard'], ['Ordering NPI', '1234567894'],
    ],
    clinical: 'Patient requests a back brace for general low back ache. No fracture, no spinal instability, no post-surgical indication.',
    steps: [
      { q: 'Step 1 — Submit: Medicare covers L0631 only for specific indications. What must be documented?',
        options: ['Patient preference for a brace', 'A covered indication (e.g., spinal fracture, instability, post-surgical) with supporting records', 'The supplier accreditation', 'The patient supplemental insurance'],
        answer: 1, points: 10,
        explanation: 'DME coverage is LCD-driven. L0631 needs a qualifying diagnosis — general back ache (M54.5) does not meet the LCD.',
        hint: 'Check the Local Coverage Determination, not the patient wishes.' },
      { q: 'Step 2 — Decision: "Denied — not medically necessary (CO-50)." The supplier already delivered the brace. Who owes?',
        options: ['Medicare — resubmit until it pays', 'The supplier — always', 'The patient — but ONLY if a valid ABN was signed before delivery', 'Nobody — write it off silently'],
        answer: 2, points: 10,
        explanation: 'Without a signed Advance Beneficiary Notice (ABN) before delivery, the supplier cannot bill the patient — supplier liability. ABN shifts liability only when properly executed pre-service.',
        hint: 'What form protects the supplier?' },
      { q: 'Step 3 — Root-cause fix so this never repeats. What process change?',
        options: ['Stop ordering all DME', 'Pre-delivery coverage check: verify LCD criteria + obtain signed ABN when coverage is uncertain', 'Bill DME under a different HCPCS', 'Have patients sign blank ABNs at check-in'],
        answer: 1, points: 10,
        explanation: 'Front-end coverage verification + valid ABN workflow prevents DME denials from becoming supplier write-offs. Blank ABNs are invalid.',
        hint: 'Fix it upstream, not after delivery.' },
    ],
  },
];

// ---- Clearinghouse Simulator (fictional) ----
// Teaches 277CA-style acknowledgments: accepted vs rejected claims and the fix-resubmit loop.
const CLEARINGHOUSE = [
  {
    id: 'CH-01', title: 'Rejected — Missing Rendering NPI', difficulty: 'Beginner',
    payer: 'Aetna (Simulated)',
    claim: [
      ['Claim', 'CLM-2026-90001'], ['Patient', 'PT-10021 · DOB 03/22/1985'],
      ['DOS', '2026-09-10'], ['CPT', '99213 — Office visit'],
      ['Rendering NPI', '(blank)'], ['Billing NPI', '1234567890'],
      ['Diagnosis', 'J06.9 — Acute upper respiratory infection'],
    ],
    ack277: '277CA · Claim Status Category A7 (acknowledgement / rejected) · Entity: rendering provider · "NPI missing or invalid — claim rejected at clearinghouse, NOT forwarded to payer."',
    steps: [
      { q: 'The 277CA shows rejection before the payer. What does that mean?',
        options: ['The payer denied the claim (CO-16)', 'The clearinghouse caught a structural error — the payer never saw it', 'The claim paid at zero', 'The patient owes the balance'],
        answer: 1, points: 10,
        explanation: 'Clearinghouse rejections happen pre-payer: the claim failed structural validation and was never forwarded. Fix and resubmit — this is not a payer denial.',
        hint: 'Did the payer ever see this claim?' },
      { q: 'What is the correct fix?',
        options: ['Appeal to Aetna with medical records', 'Add the 10-digit rendering NPI and resubmit as a new claim', 'Write off the charge', 'Change the diagnosis code'],
        answer: 1, points: 10,
        explanation: 'Missing NPI = correct the data and resubmit. Never appeal a clearinghouse rejection — there is no payer decision to appeal.',
        hint: 'What field is blank?' },
    ],
  },
  {
    id: 'CH-02', title: 'Rejected — Invalid Diagnosis Pointer', difficulty: 'Beginner',
    payer: 'BCBS (Simulated)',
    claim: [
      ['Claim', 'CLM-2026-90002'], ['Patient', 'PT-10022 · DOB 11/05/1990'],
      ['DOS', '2026-09-12'], ['Line 1', '99213 — dx pointer 1'],
      ['Line 2', '36415 — venipuncture — dx pointer 3'],
      ['Diagnoses on claim', '1: E11.9 (diabetes), 2: I10 (hypertension)'],
    ],
    ack277: '277CA · Rejected · "Diagnosis pointer 3 invalid — claim lists only 2 diagnoses."',
    steps: [
      { q: 'Why did the clearinghouse reject this claim?',
        options: ['Venipuncture is never covered', 'Line 2 points to diagnosis #3 but only 2 diagnoses exist on the claim', 'BCBS timed out', 'The DOS is in the future'],
        answer: 1, points: 10,
        explanation: 'Every diagnosis pointer must reference a diagnosis actually on the claim (1-2 here). Pointer 3 = structural error.',
        hint: 'Count the diagnoses. Count the pointer.' },
      { q: 'Correct fix?',
        options: ['Add a third diagnosis to match the pointer', 'Correct line 2 pointer to 1 or 2 (whichever supports venipuncture) and resubmit', 'Delete line 2', 'Appeal with the lab order'],
        answer: 1, points: 10,
        explanation: 'Point to the diagnosis that justifies the service — never invent a diagnosis to match a typo. Then resubmit.',
        hint: 'Fix the pointer, not the medicine.' },
    ],
  },
  {
    id: 'CH-03', title: 'Rejected — DOB Mismatch', difficulty: 'Intermediate',
    payer: 'UnitedHealthcare (Simulated)',
    claim: [
      ['Claim', 'CLM-2026-90003'], ['Patient', 'PT-10023 · DOB on claim 07/14/1978'],
      ['Subscriber', 'Same patient · DOB on payer file 07/14/1987'],
      ['DOS', '2026-09-14'], ['CPT', '97110 — Therapeutic exercises'],
    ],
    ack277: '277CA · Rejected · "Subscriber DOB does not match payer eligibility file."',
    steps: [
      { q: 'The DOB on the claim (1978) differs from the payer file (1987). Most likely cause?',
        options: ['The payer system is always wrong', 'Front-desk typo at registration — one digit off', 'The patient committed fraud', 'The claim needs a modifier'],
        answer: 1, points: 10,
        explanation: 'DOB mismatches are classic front-end errors — a transposed digit at registration. Verify against the photo ID / insurance card.',
        hint: '1978 vs 1987 — what kind of error is that?' },
      { q: 'Correct fix?',
        options: ['Verify the correct DOB with the patient, fix registration AND the claim, resubmit', 'Keep resubmitting — the payer will figure it out', 'Bill the patient directly', 'Change the payer'],
        answer: 0, points: 10,
        explanation: 'Fix the source (registration) and the claim, then resubmit. Resubmitting bad data just burns timely-filing days.',
        hint: 'Fix it at the source.' },
    ],
  },
  {
    id: 'CH-04', title: 'Rejected — Subscriber Not Found', difficulty: 'Intermediate',
    payer: 'Cigna (Simulated)',
    claim: [
      ['Claim', 'CLM-2026-90004'], ['Patient', 'PT-10024 (dependent child, DOB 05/30/2019)'],
      ['Subscriber ID on claim', 'CIG99887766'], ['DOS', '2026-09-15'],
      ['CPT', '99213 — Office visit'],
    ],
    ack277: '277CA · Rejected · "Subscriber/member ID not found on payer file."',
    steps: [
      { q: 'Member ID not found. What should you check FIRST?',
        options: ['Whether the claim needs an appeal', 'The insurance card: is the ID copied correctly, and is this the right payer/plan?', 'The diagnosis code', 'The provider NPI'],
        answer: 1, points: 10,
        explanation: 'First verify the card data: transposed ID digits and wrong-payer submissions (e.g., billed Cigna, actually Aetna) cause most "not found" rejections.',
        hint: 'Garbage in — what is the most likely garbage?' },
      { q: 'The card shows the ID is correct but the plan changed employers on 09/01. The DOS is 09/15. What now?',
        options: ['Resubmit to Cigna with a corrected claim form', 'Verify the NEW coverage (270/271) and bill the correct payer — this is a COB/eligibility issue, not a typo', 'Write off the visit', 'Ask the patient to pay cash'],
        answer: 1, points: 10,
        explanation: 'Coverage changed before the DOS — the old payer correctly says "not found." Re-verify eligibility and route to the active payer.',
        hint: 'The ID is right. What else changed?' },
    ],
  },
  {
    id: 'CH-05', title: 'Rejected — Duplicate Submission', difficulty: 'Advanced',
    payer: 'Medicare (Simulated)',
    claim: [
      ['Claim', 'CLM-2026-90005 (2nd submission)'], ['Original', 'CLM-2026-90000 submitted 2026-09-02'],
      ['Patient', 'PT-10025'], ['DOS', '2026-08-28'], ['CPT', 'G0438 — Annual wellness visit'],
      ['Status of original', 'Still processing — no payer response yet'],
    ],
    ack277: '277CA · Rejected · "Duplicate claim — original still in process."',
    steps: [
      { q: 'You resubmitted because the original seemed "stuck." Why is this wrong?',
        options: ['It is not wrong — resubmitting speeds things up', 'Blind resubmission creates duplicates; check claim status (276/277) before ever resubmitting', 'Medicare requires duplicates', 'The CPT was wrong'],
        answer: 1, points: 10,
        explanation: 'Never resubmit a claim that is still processing. Use the 276/277 claim-status transaction to check it. Duplicates can trigger CO-18 denials.',
        hint: 'What should you check before touching "resubmit"?' },
      { q: 'The 277 status inquiry shows the original was actually DENIED 5 days ago (CO-16, missing info). Now what?',
        options: ['Resubmit the same claim a third time', 'Submit a CORRECTED claim with the missing info (correct claim, not a duplicate)', 'Appeal the duplicate rejection', 'Give up and write it off'],
        answer: 1, points: 10,
        explanation: 'Now you have a real denial with a reason: fix the CO-16 issue and send a corrected claim (with the original claim number referenced).',
        hint: 'The status check gave you the real answer — act on it.' },
    ],
  },
  {
    id: 'CH-06', title: 'Accepted — Clean Claim Passes', difficulty: 'Beginner',
    payer: 'Aetna (Simulated)',
    claim: [
      ['Claim', 'CLM-2026-90006'], ['Patient', 'PT-10026 · DOB 02/18/1975'],
      ['DOS', '2026-09-18'], ['CPT', '99213-25 + 11100 (biopsy)'],
      ['Rendering NPI', '1234567890'], ['Billing NPI', '1234567890'],
      ['Diagnoses', '1: L82.1 (seborrheic keratosis), 2: Z01.00'],
      ['Pointers', '99213 to 1, 11100 to 1'],
    ],
    ack277: '277CA · ACCEPTED · "Claim passed clearinghouse validation and was forwarded to Aetna."',
    steps: [
      { q: 'The 277CA says ACCEPTED. What does that guarantee?',
        options: ['The claim will be paid in full', 'Only that it passed structural checks and reached the payer — adjudication (pay/deny) comes next', 'The patient owes nothing', 'No prior auth is needed'],
        answer: 1, points: 10,
        explanation: 'Accepted is not paid. The clearinghouse only validates structure. The payer still adjudicates: it can pay, deny, or pend.',
        hint: 'Who makes the payment decision?' },
      { q: 'Next step in the workflow after a 277CA accept?',
        options: ['Post the payment immediately', 'Track the claim (aged AR) until the 835 ERA / payer response arrives, then post', 'Call the patient for the balance', 'Close the encounter'],
        answer: 1, points: 10,
        explanation: 'Monitor until the payer responds via 835 ERA, then post payment/adjustments/denials. Silence after 30 days = follow up.',
        hint: 'What document tells you the payer decision?' },
    ],
  },
];


// ===== HIPAA COMPLIANCE TRAINING scenarios =====
// 18 real-world scenarios: Privacy Rule, Security Rule, Breach Notification.
// answer = index of correct option. passPct = 80.
const HIPAA_PASS_PCT = 80;
const HIPAA = [
 { id: 'HIP-01', topic: 'Privacy Rule · PHI', difficulty: 'Beginner',
   q: 'A patient\u2019s spouse calls asking for the results of yesterday\u2019s lab tests. What is the correct action?',
   options: [
    'Share the results \u2014 spouses are always allowed to receive PHI.',
    'Share only if the patient gave permission, or the spouse is involved in the patient\u2019s care and the patient did not object.',
    'Refuse completely \u2014 family members may never receive PHI.',
    'Share the results but document it as a breach.'],
   answer: 1,
   why: 'HIPAA permits sharing PHI with family involved in care when the patient agrees or does not object (45 CFR 164.510(b)). Spouses have no automatic right. Always verify permission or involvement first.' },
 { id: 'HIP-02', topic: 'Privacy Rule · Minimum Necessary', difficulty: 'Beginner',
   q: 'An insurer requests records to process a claim for a knee X-ray. Under the minimum necessary standard you should send:',
   options: [
    'The patient\u2019s entire medical record \u2014 the payer decides what is relevant.',
    'Only the information reasonably necessary: the X-ray order, report, and related visit note.',
    'Nothing \u2014 payers are never entitled to PHI.',
    'A summary written from memory, without the actual documents.'],
   answer: 1,
   why: 'The minimum necessary standard requires limiting PHI to the amount reasonably necessary for the purpose. Sending the full chart for one X-ray claim is a classic violation.' },
 { id: 'HIP-03', topic: 'Privacy Rule · Social Media', difficulty: 'Beginner',
   q: 'A nurse posts about \u201ca difficult trauma case last night\u201d on social media without naming the patient. Is this a HIPAA violation?',
   options: [
    'No \u2014 no name was used, so it is not PHI.',
    'Yes \u2014 details can identify the patient, and workforce members may not disclose PHI on social media.',
    'Only if the patient complains.',
    'No \u2014 personal social media is outside HIPAA.'],
   answer: 1,
   why: 'PHI includes any information that could identify the individual. Case details (date, facility, injury type) can be identifying. OCR has fined providers for social media disclosures.' },
 { id: 'HIP-04', topic: 'Security Rule · ePHI', difficulty: 'Intermediate',
   q: 'A physician wants to text a photo of a wound to a consulting specialist from a personal phone. What is compliant?',
   options: [
    'Fine \u2014 texting is fast and the specialist needs it.',
    'Only through a secure, encrypted messaging system approved by the organization; standard SMS is not secure.',
    'Fine as long as the patient\u2019s name is not in the photo.',
    'Fine if the message is deleted afterward.'],
   answer: 1,
   why: 'ePHI must be protected by technical safeguards (encryption, access controls). Standard SMS is unencrypted and stored by carriers \u2014 use only approved secure messaging.' },
 { id: 'HIP-05', topic: 'Breach Notification', difficulty: 'Intermediate',
   q: 'A breach affecting 600 patients is discovered on March 1. What notifications are required?',
   options: [
    'Notify each affected individual within 60 days; notify HHS and prominent local media because 500+ are affected.',
    'Notify individuals within 30 days; HHS notification is optional.',
    'Only notify HHS within 60 days \u2014 individuals are notified by HHS.',
    'Post a notice on the website; individual letters are not required.'],
   answer: 0,
   why: 'Breach rule: notify each affected individual without unreasonable delay and within 60 days. Breaches of 500+ trigger HHS notification AND notice to prominent media in the affected state.' },
 { id: 'HIP-06', topic: 'Patient Rights', difficulty: 'Beginner',
   q: 'A patient requests a copy of their medical records. How quickly must you respond?',
   options: [
    'Within 90 days.',
    'Within 30 days (one 30-day extension allowed with written explanation).',
    'Immediately \u2014 same day, no exceptions.',
    'There is no deadline as long as you respond eventually.'],
   answer: 1,
   why: 'The Privacy Rule gives patients the right of access within 30 days; a single 30-day extension is allowed with a written reason. Many states are stricter.' },
 { id: 'HIP-07', topic: 'Business Associates', difficulty: 'Intermediate',
   q: 'Your practice hires a company to shred old paper charts. What is required before they touch the records?',
   options: [
    'Nothing \u2014 shredding destroys PHI, so HIPAA does not apply.',
    'A signed Business Associate Agreement (BAA).',
    'A verbal promise to keep things confidential.',
    'Only a background check on their staff.'],
   answer: 1,
   why: 'Any vendor that creates, receives, maintains, or transmits PHI on your behalf is a Business Associate and must sign a BAA. No BAA = you are liable for their breach.' },
 { id: 'HIP-08', topic: 'Privacy Rule · Marketing', difficulty: 'Intermediate',
   q: 'The marketing team wants to mail former cardiology patients about a new heart-screening package. Is patient authorization needed?',
   options: [
    'No \u2014 it is healthcare operations.',
    'Yes \u2014 using PHI to market a service requires prior written authorization, with limited exceptions.',
    'Only if the mailing mentions a diagnosis.',
    'No \u2014 as long as the practice sends it itself.'],
   answer: 1,
   why: 'Marketing communications using PHI require authorization. Face-to-face communication and small promotional gifts are exceptions; a targeted mailing is not.' },
 { id: 'HIP-09', topic: 'Privacy Rule · Deceased', difficulty: 'Advanced',
   q: 'How long does HIPAA protect the PHI of a deceased patient?',
   options: [
    'Protection ends at death.',
    '50 years after death.',
    '10 years after death.',
    'Forever.'],
   answer: 1,
   why: 'HIPAA protects decedent PHI for 50 years following death. After that, the information is no longer PHI under the Privacy Rule.' },
 { id: 'HIP-10', topic: 'Privacy Rule · Psychotherapy Notes', difficulty: 'Advanced',
   q: 'A payer requests psychotherapy notes to review a claim. What applies?',
   options: [
    'Send them \u2014 payers may review any record for payment purposes.',
    'Psychotherapy notes have special protection: they generally cannot be disclosed without the patient\u2019s specific authorization, with narrow exceptions.',
    'Send a summary instead of the full notes.',
    'Refuse \u2014 psychotherapy notes can never be disclosed.'],
   answer: 1,
   why: 'Psychotherapy notes (the clinician\u2019s separate process notes) get heightened protection and need specific authorization. They are distinct from the general mental-health record.' },
 { id: 'HIP-11', topic: 'Privacy Rule · Minimum Necessary', difficulty: 'Advanced',
   q: 'The minimum necessary standard does NOT apply to which disclosure?',
   options: [
    'Disclosures to a health plan for payment.',
    'Disclosures to the individual who is the subject of the PHI.',
    'Disclosures for research with a waiver.',
    'Disclosures to a business associate.'],
   answer: 1,
   why: 'Minimum necessary does not apply to disclosures to the individual, disclosures pursuant to authorization, or disclosures required by law \u2014 including treatment disclosures between providers.' },
 { id: 'HIP-12', topic: 'Security Rule · Safeguards', difficulty: 'Intermediate',
   q: 'Which of the following is a REQUIRED technical safeguard under the Security Rule?',
   options: [
    'Automatic logoff of unattended workstations.',
    'Biometric door locks on every office.',
    'Annual staff holiday party.',
    'Paper shredders in every exam room.'],
   answer: 0,
   why: 'The Security Rule\u2019s three safeguard categories are administrative, physical, and technical. Automatic logoff, unique user IDs, and encryption are core technical safeguards for ePHI.' },
 { id: 'HIP-13', topic: 'Patient Rights · Amendment', difficulty: 'Intermediate',
   q: 'A patient asks you to amend (correct) their record because a diagnosis is wrong. You believe the record is accurate. What now?',
   options: [
    'Ignore the request \u2014 providers never have to amend.',
    'Amend it immediately, no questions asked.',
    'You may deny in writing with the reason, but must allow the patient to submit a written statement of disagreement kept with the record.',
    'Charge a fee to process the amendment.'],
   answer: 2,
   why: 'Patients have the right to request amendment. Providers may deny with a written explanation, but must permit a statement of disagreement to be appended to the record.' },
 { id: 'HIP-14', topic: 'Privacy Rule · Incidental Disclosure', difficulty: 'Advanced',
   q: 'A visitor overhears a nurse giving discharge instructions at the front desk. Is this a HIPAA violation?',
   options: [
    'Yes \u2014 all overheard PHI is a breach.',
    'No \u2014 incidental disclosures are permitted when reasonable safeguards (lowered voices, private areas where possible) are in place.',
    'Only if the visitor is a reporter.',
    'Yes, unless the patient signed a waiver that morning.'],
   answer: 1,
   why: 'Incidental disclosures that occur despite reasonable safeguards are permitted. HIPAA requires reasonable \u2014 not perfect \u2014 protection (e.g., speaking quietly, not discussing PHI in elevators).' },
 { id: 'HIP-15', topic: 'Patient Rights · Electronic Access', difficulty: 'Intermediate',
   q: 'A patient asks you to email their lab results to their personal Gmail. What is correct?',
   options: [
    'Refuse \u2014 email is never allowed for PHI.',
    'Allowed if the patient requested it in this form; warn them of security risks and send to the address they specified.',
    'Allowed only through the patient portal.',
    'Allowed only with a signed BAA from Google.'],
   answer: 1,
   why: 'Patients have the right to receive PHI in the form they request, including unencrypted email, once warned of the risks. Document the request and the warning.' },
 { id: 'HIP-16', topic: 'Breach Notification · Risk Assessment', difficulty: 'Advanced',
   q: 'An unencrypted laptop with 200 patient records is stolen from a locked car. What is the first compliance step?',
   options: [
    'Assume it is not a breach because the car was locked.',
    'Perform the four-factor breach risk assessment; unencrypted lost/stolen ePHI is presumed a breach unless the assessment shows low probability of compromise.',
    'Wait 60 days to see if the data is misused.',
    'Only notify the police \u2014 HIPAA does not cover theft.'],
   answer: 1,
   why: 'Lost or stolen unencrypted ePHI is presumed a breach. The four-factor risk assessment (nature of PHI, unauthorized person, whether PHI was acquired/viewed, mitigation) determines if notification is required.' },
 { id: 'HIP-17', topic: 'Privacy Rule · Law Enforcement', difficulty: 'Advanced',
   q: 'Police ask for a patient\u2019s discharge paperwork after an assault, without a warrant or patient authorization. You may disclose:',
   options: [
    'Nothing at all \u2014 ever.',
    'Limited information as permitted: e.g., as required by law, to identify a suspect with a lawful request, or to avert a serious threat \u2014 following the minimum necessary rule.',
    'The full chart \u2014 law enforcement overrides HIPAA.',
    'Only the patient\u2019s billing address.'],
   answer: 1,
   why: 'HIPAA permits (not requires) limited disclosures to law enforcement in specific situations \u2014 court orders, identifying suspects/victims, averting serious threats. Minimum necessary still applies.' },
 { id: 'HIP-18', topic: 'Enforcement · Penalties', difficulty: 'Intermediate',
   q: 'A practice willfully neglects HIPAA safeguards and does not correct the violation within 30 days. Which penalty tier applies?',
   options: [
    'Tier 1 \u2014 the practice did not know.',
    'Tier 2 \u2014 reasonable cause.',
    'Tier 3 \u2014 willful neglect, corrected within 30 days.',
    'Tier 4 \u2014 willful neglect NOT corrected within 30 days: the maximum tier, $70,000+ per violation with multi-million annual caps.'],
   answer: 3,
   why: 'OCR penalty tiers: Tier 1 (did not know), Tier 2 (reasonable cause), Tier 3 (willful neglect \u2014 corrected), Tier 4 (willful neglect \u2014 not corrected). Tier 4 carries the maximum per-violation penalties.' },
];

// ===== LCD / NCD COVERAGE CHECKER scenarios =====
// decision: 'covered' | 'conditional' | 'not-covered'. abn: whether an ABN is recommended.
const COVERAGE = [
 { id: 'COV-01', cpt: '82306', cptDesc: 'Vitamin D, 25-hydroxy', icd: 'E55.9', icdDesc: 'Vitamin D deficiency, unspecified',
   decision: 'covered', lcd: 'L34541 (Simulated)', abn: false,
   conditions: ['Covered when deficiency is suspected or documented (E55.9, E55.0).'],
   why: 'Medicare LCDs cover Vitamin D testing for suspected deficiency, malabsorption, or chronic kidney disease. Routine screening in asymptomatic patients is NOT covered \u2014 get an ABN (G0299 with GA modifier) before testing.' },
 { id: 'COV-02', cpt: '82306', cptDesc: 'Vitamin D, 25-hydroxy', icd: 'Z13.1', icdDesc: 'Encounter for screening for diabetes mellitus',
   decision: 'not-covered', lcd: 'L34541 (Simulated)', abn: true,
   conditions: ['Screening diagnosis (Z-codes) does not support medical necessity.'],
   why: 'Vitamin D ordered as routine screening (Z13.1) will deny as not medically necessary. Have the patient sign an ABN so the cost can shift to them; otherwise the practice absorbs it.' },
 { id: 'COV-03', cpt: 'G0103', cptDesc: 'PSA screening', icd: 'Z12.5', icdDesc: 'Encounter for screening for malignant neoplasm of prostate',
   decision: 'covered', lcd: 'NCD 210.1 (Simulated)', abn: false,
   conditions: ['Medicare covers annual PSA screening for men age 50+.'],
   why: 'NCD 210.1 covers prostate cancer screening (G0103 + DRE G0102) once every 12 months for men 50 and older. Diagnostic PSA (84153) needs a signs/symptoms diagnosis instead.' },
 { id: 'COV-04', cpt: '98940', cptDesc: 'Chiropractic manipulative treatment, 1-2 regions', icd: 'M54.5', icdDesc: 'Low back pain',
   decision: 'conditional', lcd: 'L34585 (Simulated)', abn: true,
   conditions: ['Medicare covers ONLY manual manipulation of the spine to correct subluxation \u2014 bill with the AT modifier.', 'The diagnosis must support subluxation (e.g., M99.03), not just pain.'],
   why: 'Medicare chiropractic coverage is narrow: spinal manipulation for subluxation only, with AT modifier. M54.5 alone without subluxation documentation risks denial \u2014 verify documentation or obtain an ABN.' },
 { id: 'COV-05', cpt: '97810', cptDesc: 'Acupuncture, initial 15 min', icd: 'M54.5', icdDesc: 'Low back pain',
   decision: 'conditional', lcd: 'NCD 30.3.3 (Simulated)', abn: true,
   conditions: ['Covered ONLY for chronic low back pain (12+ weeks), up to 12 visits in 90 days, max 20/year.', 'Pain must be chronic \u2014 acute low back pain is not covered.'],
   why: 'NCD 30.3.3 covers acupuncture solely for chronic low back pain within strict visit limits. Document chronicity (12+ weeks); anything else needs an ABN.' },
 { id: 'COV-06', cpt: '77080', cptDesc: 'Bone density study (DEXA), axial', icd: 'Z01.89', icdDesc: 'Encounter for other specified special examinations',
   decision: 'conditional', lcd: 'L34539 (Simulated)', abn: true,
   conditions: ['Covered every 2 years for at-risk patients (estrogen deficiency, osteoporosis, steroid therapy, hyperparathyroidism).', 'Routine screening without risk factors is not covered.'],
   why: 'Medicare covers DEXA every 23 months for qualified at-risk individuals. A generic Z01.89 encounter without risk-factor diagnoses will deny \u2014 use supporting diagnoses (e.g., M81.0) or an ABN.' },
 { id: 'COV-07', cpt: 'G0121', cptDesc: 'Screening colonoscopy, average risk', icd: 'Z12.11', icdDesc: 'Encounter for screening for malignant neoplasm of colon',
   decision: 'covered', lcd: 'NCD 210.3 (Simulated)', abn: false,
   conditions: ['Average risk: every 10 years (120 months).', 'High risk uses G0105 (every 24 months).'],
   why: 'NCD 210.3 covers screening colonoscopy on schedule. Watch frequency edits \u2014 a G0121 within 10 years of a prior screening denies; check claim history first.' },
 { id: 'COV-08', cpt: '15823', cptDesc: 'Blepharoplasty, upper eyelid', icd: 'H02.401', icdDesc: 'Unspecified ptosis of right eyelid',
   decision: 'conditional', lcd: 'L34528 (Simulated)', abn: true,
   conditions: ['Covered only with documented visual field impairment (taped vs untaped visual fields).', 'Cosmetic blepharoplasty is never covered.'],
   why: 'Eyelid surgery is covered only for functional impairment \u2014 LCDs require visual field testing showing obstruction. Without it, this is cosmetic: ABN required.' },
 { id: 'COV-09', cpt: '97110', cptDesc: 'Therapeutic exercises', icd: 'M25.561', icdDesc: 'Pain in right knee',
   decision: 'covered', lcd: 'L34514 (Simulated)', abn: false,
   conditions: ['Covered with medical necessity; append KX modifier to attest necessity above cap thresholds.', 'Document functional limitation and progress.'],
   why: 'Outpatient therapy is covered when medically necessary. Use the KX modifier to confirm necessity; without it, claims over the threshold deny. Maintenance therapy is not covered.' },
 { id: 'COV-10', cpt: '81211', cptDesc: 'BRCA1/2 gene analysis', icd: 'Z80.3', icdDesc: 'Family history of malignant neoplasm of breast',
   decision: 'conditional', lcd: 'L35396 (Simulated)', abn: true,
   conditions: ['Covered when LCD family-history/personal-history criteria are met (early-onset relatives, multiple primaries, etc.).', 'Genetic counseling documentation strengthens the claim.'],
   why: 'BRCA testing LCDs require specific risk criteria \u2014 not every family history qualifies. Verify the pedigree against the LCD; otherwise obtain an ABN because these tests are expensive.' },
 { id: 'COV-11', cpt: '11042', cptDesc: 'Debridement, subcutaneous tissue, first 20 sq cm', icd: 'L97.512', icdDesc: 'Non-pressure chronic ulcer of left foot with fat layer exposed',
   decision: 'covered', lcd: 'L34536 (Simulated)', abn: false,
   conditions: ['Covered for documented chronic ulcers with depth/tissue type matching the debridement level.'],
   why: 'Debridement LCDs tie coverage to ulcer depth and tissue removed. Document measurements, tissue type, and medical necessity \u2014 mismatched depth is a top denial reason.' },
 { id: 'COV-12', cpt: '95811', cptDesc: 'Polysomnography with CPAP titration', icd: 'G47.33', icdDesc: 'Obstructive sleep apnea',
   decision: 'covered', lcd: 'L34526 (Simulated)', abn: false,
   conditions: ['Covered with documented symptoms (snoring, witnessed apneas, daytime sleepiness) and exam findings.'],
   why: 'Sleep study LCDs require clinical signs of sleep apnea before testing. Document the Epworth score, BMI, and witnessed symptoms to support medical necessity.' },
 { id: 'COV-13', cpt: '43644', cptDesc: 'Gastric bypass (Roux-en-Y)', icd: 'E66.01', icdDesc: 'Morbid (severe) obesity due to excess calories',
   decision: 'conditional', lcd: 'NCD 100.1 (Simulated)', abn: true,
   conditions: ['BMI \u226540, or \u226535 with comorbidity; documented failed supervised weight-loss program; facility must be certified.'],
   why: 'NCD 100.1 covers bariatric surgery only when all criteria are met, at approved facilities. Missing documentation = denial; verify every element pre-service.' },
 { id: 'COV-14', cpt: 'G0277', cptDesc: 'Hyperbaric oxygen, full body chamber, per 30 min', icd: 'L97.513', icdDesc: 'Non-pressure chronic ulcer of right foot with necrosis of muscle',
   decision: 'conditional', lcd: 'NCD 20.29 (Simulated)', abn: true,
   conditions: ['Covered for diabetic foot ulcers Wagner grade 3+ after 30 days of standard care without improvement.', 'Daily physician evaluation required.'],
   why: 'NCD 20.29 lists covered HBO conditions narrowly. Diabetic ulcers need Wagner 3+ grading plus 30 days of failed standard therapy documented before HBO is covered.' },
 { id: 'COV-15', cpt: '81479', cptDesc: 'Unlisted molecular pathology procedure', icd: 'Z13.1', icdDesc: 'Encounter for screening',
   decision: 'not-covered', lcd: 'NCD 90.2 (Simulated)', abn: true,
   conditions: ['Unlisted genetic tests for screening are generally non-covered.', 'Warfarin-sensitivity genotyping is a published NCD non-coverage example.'],
   why: 'NCD 90.2 and related policies non-cover many next-gen sequencing screening uses. Unlisted molecular codes billed for screening will deny \u2014 ABN is essential.' },
 { id: 'COV-16', cpt: '11719', cptDesc: 'Trimming of nondystrophic nails', icd: 'L60.0', icdDesc: 'Ingrowing nail',
   decision: 'conditional', lcd: 'L34533 (Simulated)', abn: true,
   conditions: ['Routine foot care is covered only with systemic conditions (diabetes with LOPS, PVD) \u2014 use Q7/Q8/Q9 modifiers.', 'L60.0 alone without systemic disease = routine, non-covered.'],
   why: 'Medicare excludes routine foot care. Coverage requires systemic disease (e.g., E11.621 + L97.5xx) plus Q-modifiers attesting findings. Document class findings or obtain an ABN.' },
];

module.exports = { PAYERS, scrubClaim, DENIALS, ERA, ERA_ACTIONS, STATEMENTS, STATEMENT_ACTIONS, FDCPA_RULES, UB04, NCCI_PAIRS, CRED, CRED_STEPS_INFO, PRIOR_AUTH, CLEARINGHOUSE, HIPAA, HIPAA_PASS_PCT, COVERAGE };

