import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {holdLinuxFixtureStart} from './support/linux-start-frame.js';

for (const encoding of ['string', 'buffer'] as const) {
  test(`Linux fence fixture holds a bound JSON START ${encoding} and forwards its exact bytes and callback`, async () => {
    const control = new PassThrough(), output: Buffer[] = [];
    let release!: () => void, starts = 0, callbacks = 0;
    const resume = new Promise<void>(done => {release = done;});
    const frame = ' {"type":"START", "version":1,"binding":"' + 'a'.repeat(64) +
      '","incarnation":"11111111-1111-4111-8111-111111111111","notAfterMonotonicNs":"123456789"}\n';
    const input = encoding === 'string' ? frame : Buffer.from(frame);
    control.on('data', chunk => {output.push(chunk);});
    holdLinuxFixtureStart(control, () => {starts++;}, resume);
    assert.equal(control.write(input, () => {callbacks++;}), true);
    assert.equal(starts, 1); assert.equal(callbacks, 0); assert.equal(output.length, 0);
    control.write('SEAL\n');
    assert.equal(Buffer.concat(output).toString(), 'SEAL\n');
    release(); await resume; await new Promise<void>(done => setImmediate(done));
    assert.equal(Buffer.concat(output).toString(), 'SEAL\n' + frame);
    if (Buffer.isBuffer(input)) assert.equal(output[1], input);
    assert.equal(callbacks, 1); control.destroy();
  });
}

test('Linux fence fixture forwards legacy, non-START and malformed frames without pausing', () => {
  const control = new PassThrough(), output: Buffer[] = [];
  control.on('data', chunk => {output.push(chunk);});
  holdLinuxFixtureStart(control, () => assert.fail('Only the current JSON START frame may pause.'), new Promise(() => {}));
  const frames = ['START\n', 'TERM\n', '{"type":"START","version":2}\n', '{"event":"started"}\n', 'null\n', '{bad json\n'];
  for (const frame of frames) control.write(frame);
  assert.equal(Buffer.concat(output).toString(), frames.join('')); control.destroy();
});
