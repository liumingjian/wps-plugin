import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

vm.runInThisContext(await readFile(new URL('./configuration.js', import.meta.url), 'utf8'), { filename: 'configuration.js' });

const { validate } = RoadFlowConfiguration;
assert.deepEqual(validate({
  trustedOrigin: 'https://oa.example.test/',
  gatewayTemplate: 'https://gateway.example.test/wps/document?fileurl={sourcePath}'
}), {
  ok: true,
  value: {
    trustedOrigin: 'https://oa.example.test'
  }
});
assert.deepEqual(RoadFlowConfiguration.permissionPatterns({
  trustedOrigin: 'https://oa.example.test'
}), ['https://oa.example.test/*']);

for (const input of [
  { trustedOrigin: '' },
  { trustedOrigin: 'https://oa.example.test/path' },
  { trustedOrigin: 'https://alice:secret@oa.example.test' },
  { trustedOrigin: 'file:///oa' }
]) {
  const result = validate(input);
  assert.equal(result.ok, false, `accepted ${JSON.stringify(input)}`);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
}
