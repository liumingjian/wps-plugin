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
    trustedOrigin: 'https://oa.example.test',
    gatewayTemplate: 'https://gateway.example.test/wps/document?fileurl={sourcePath}'
  }
});

for (const input of [
  { trustedOrigin: '', gatewayTemplate: 'https://gateway.example.test/{sourcePath}' },
  { trustedOrigin: 'https://oa.example.test/path', gatewayTemplate: 'https://gateway.example.test/{sourcePath}' },
  { trustedOrigin: 'https://alice:secret@oa.example.test', gatewayTemplate: 'https://gateway.example.test/{sourcePath}' },
  { trustedOrigin: 'file:///oa', gatewayTemplate: 'https://gateway.example.test/{sourcePath}' },
  { trustedOrigin: 'https://oa.example.test', gatewayTemplate: 'https://gateway.example.test/document' },
  { trustedOrigin: 'https://oa.example.test', gatewayTemplate: 'https://gateway.example.test/{sourcePath}/{sourcePath}' },
  { trustedOrigin: 'https://oa.example.test', gatewayTemplate: 'https://alice:secret@gateway.example.test/{sourcePath}' },
  { trustedOrigin: 'https://oa.example.test', gatewayTemplate: 'file:///gateway/{sourcePath}' }
]) {
  const result = validate(input);
  assert.equal(result.ok, false, `accepted ${JSON.stringify(input)}`);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
}
