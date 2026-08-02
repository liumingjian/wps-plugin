import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

vm.runInThisContext(await readFile(new URL('./identity-gate.js', import.meta.url), 'utf8'), {
  filename: 'identity-gate.js'
});

const handoffID = 'a'.repeat(64);
const sourceIdentity = {
  sourcePath: '/documents/Quarterly%20Report.DOCX',
  actualFormat: 'docx',
  byteCount: 4096,
  sha256: 'b'.repeat(64)
};
const now = Date.parse('2026-08-02T12:00:00.000Z');

const endpoints = RoadFlowIdentityGate.endpoints(
  'https://gateway.example.test/wps/v1/document?fileurl={sourcePath}&mode=word',
  sourceIdentity.sourcePath,
  'c'.repeat(32),
  handoffID
);
assert.deepEqual(endpoints, {
  documentURL: 'https://gateway.example.test/wps/v1/document?fileurl=%2Fdocuments%2FQuarterly%2520Report.DOCX&mode=word&_wpsHandoff=cccccccccccccccccccccccccccccccc',
  receiptURL: `https://gateway.example.test/wps/v1/delivery-receipt?handoff=${handoffID}`
});

const receipt = {
  handoff: handoffID,
  sourcePath: sourceIdentity.sourcePath,
  actualFormat: 'docx',
  byteCount: 4096,
  sha256: sourceIdentity.sha256,
  deliveredAt: new Date(now - 500).toISOString()
};
assert.deepEqual(
  RoadFlowIdentityGate.validateReceipt(receipt, handoffID, sourceIdentity, now, now - 1000),
  receipt
);

for (const candidate of [
  undefined,
  { ...receipt, handoff: 'd'.repeat(64) },
  { ...receipt, sourcePath: '/documents/Other.docx' },
  { ...receipt, actualFormat: 'doc' },
  { ...receipt, byteCount: 4095 },
  { ...receipt, sha256: 'e'.repeat(64) },
  { ...receipt, deliveredAt: new Date(now - RoadFlowIdentityGate.RECEIPT_MAX_AGE_MS - 1).toISOString() },
  { ...receipt, deliveredAt: new Date(now + RoadFlowIdentityGate.CLOCK_SKEW_MS + 1).toISOString() },
  { ...receipt, deliveredAt: 'not-a-time' },
  { ...receipt, extra: true },
  [receipt]
]) {
  assert.equal(
    RoadFlowIdentityGate.validateReceipt(candidate, handoffID, sourceIdentity, now, now - 1000),
    undefined,
    `accepted ${JSON.stringify(candidate)}`
  );
}

assert.equal(
  RoadFlowIdentityGate.validateReceipt(
    { ...receipt, deliveredAt: new Date(now - 2001).toISOString() },
    handoffID,
    sourceIdentity,
    now,
    now - 1000
  ),
  undefined
);

assert.throws(
  () => RoadFlowIdentityGate.endpoints(
    'https://gateway.example.test/wps/document?fileurl={sourcePath}&_wpsHandoff=attacker',
    sourceIdentity.sourcePath,
    'c'.repeat(32),
    handoffID
  ),
  /cache key/i
);
assert.throws(
  () => RoadFlowIdentityGate.endpoints(
    'https://gateway.example.test/wps/document?fileurl={sourcePath}',
    '/../Other.docx',
    'c'.repeat(32),
    handoffID
  ),
  /source path/i
);
