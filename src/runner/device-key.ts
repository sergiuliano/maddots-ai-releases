import {createPrivateKey, generateKeyPairSync, sign, type KeyObject} from 'node:crypto';
import {ApiClient, isObject, isSkillsToken} from '../api.js';
import {HelperError} from '../config.js';
import {withWriteLock, type HelperPaths} from '../paths.js';
import type {SecretStore} from '../secret-store.js';
import {canonicalBase64url, deviceKeyFingerprint, deviceKeyProof} from '../shared/runner-protocol.js';

export type RunnerDeviceKey = {deviceKeyId: string; privateKey: KeyObject};
type StoredKey = {deviceKeyId: string | null; d: string; x: string};
type KeyDocument = {format: 1; keys: Record<string, StoredKey>};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function privateKey(key: StoredKey): KeyObject {
  return createPrivateKey({key: {kty: 'OKP', crv: 'Ed25519', d: key.d, x: key.x}, format: 'jwk'});
}

/** All mutations use the same lock as helper sync and pairing. */
export class DeviceKeyStore {
  constructor(private readonly options: {paths: HelperPaths; secrets: SecretStore; helperId: string; api: ApiClient}) {}
  private async read(): Promise<KeyDocument> {
    if (this.options.secrets.storage !== 'keychain') throw new HelperError('FILE_RUNS_REFUSED', 'Agent runs require Keychain storage.');
    const text = await this.options.secrets.get('device-key');
    if (text === undefined) return {format: 1, keys: {}};
    try {
      const value: unknown = JSON.parse(text);
      if (!isObject(value) || value.format !== 1 || !isObject(value.keys) || Object.keys(value).some(key => !['format', 'keys'].includes(key))) throw new Error();
      for (const [id, key] of Object.entries(value.keys)) {
        if (!uuid.test(id) || !isObject(key) || Object.keys(key).sort().join(',') !== 'd,deviceKeyId,x' ||
          !(key.deviceKeyId === null || typeof key.deviceKeyId === 'string' && uuid.test(key.deviceKeyId)) ||
          typeof key.d !== 'string' || !canonicalBase64url(key.d, 32) || typeof key.x !== 'string' || !canonicalBase64url(key.x, 32)) throw new Error();
        privateKey(key as StoredKey);
      }
      return value as KeyDocument;
    } catch {throw new HelperError('DEVICE_KEY_INVALID', 'The saved device keys are invalid. Reconnect this computer.');}
  }
  private async write(value: KeyDocument): Promise<void> {
    const text = JSON.stringify(value);
    await this.options.secrets.set('device-key', text, ['run_claim']);
    if (await this.options.secrets.get('device-key') !== text) throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify its device key update.');
  }
  /** Restore an existing registration without creating a key or requesting a grant. */
  async get(aiToolId: string): Promise<RunnerDeviceKey | undefined> {
    if (!uuid.test(aiToolId)) throw new HelperError('DEVICE_KEY_INVALID', 'The tool connection id is invalid.');
    const key = (await this.read()).keys[aiToolId];
    return key?.deviceKeyId ? {deviceKeyId: key.deviceKeyId, privateKey: privateKey(key)} : undefined;
  }
  async ensure(aiToolId: string): Promise<RunnerDeviceKey> {
    if (!uuid.test(aiToolId)) throw new HelperError('DEVICE_KEY_INVALID', 'The tool connection id is invalid.');
    return withWriteLock(this.options.paths, async () => {
      const document = await this.read();
      let key = document.keys[aiToolId];
      if (!key) {
        const jwk = generateKeyPairSync('ed25519').privateKey.export({format: 'jwk'});
        key = {deviceKeyId: null, d: jwk.d!, x: jwk.x!};
        document.keys[aiToolId] = key;
        // Persist before registration so a lost answer can reuse the same proof.
        await this.write(document);
      }
      return this.register(document, aiToolId, key);
    });
  }
  /** Retry only persisted key material. This path cannot mint a key without a grant. */
  async registerExisting(aiToolId: string): Promise<RunnerDeviceKey | undefined> {
    if (!uuid.test(aiToolId)) throw new HelperError('DEVICE_KEY_INVALID', 'The tool connection id is invalid.');
    return withWriteLock(this.options.paths, async () => {
      const document = await this.read(), key = document.keys[aiToolId];
      return key ? this.register(document, aiToolId, key) : undefined;
    });
  }
  private async register(document: KeyDocument, aiToolId: string, key: StoredKey): Promise<RunnerDeviceKey> {
    const signingKey = privateKey(key);
    if (key.deviceKeyId === null) {
      const token = await this.options.secrets.get('skills-token');
      if (!isSkillsToken(token)) throw new HelperError('TOKEN_REQUIRED', 'Connect this computer before enabling runs.');
      const result = await this.options.api.request<{deviceKeyId: string; fingerprint: string}>('/api/helper/runs/device-key', {token, body: {
        aiToolId, publicKey: key.x, proof: sign(null, Buffer.from(deviceKeyProof(this.options.helperId, aiToolId, key.x)), signingKey).toString('base64url'),
      }});
      if (!uuid.test(result.data.deviceKeyId) || result.data.fingerprint !== deviceKeyFingerprint(key.x)) throw new HelperError('API_RESPONSE_INVALID', 'The device registration answer is invalid.');
      key.deviceKeyId = result.data.deviceKeyId;
      await this.write(document);
    }
    return {deviceKeyId: key.deviceKeyId, privateKey: signingKey};
  }
  async remove(aiToolId: string, deviceKeyId: string | null): Promise<void> {
    await withWriteLock(this.options.paths, async () => {
      const document = await this.read();
      if (!Object.hasOwn(document.keys, aiToolId)) return;
      // A stale connection must not remove a replacement registered meanwhile.
      if (deviceKeyId !== null && document.keys[aiToolId].deviceKeyId !== deviceKeyId) return;
      delete document.keys[aiToolId];
      if (Object.keys(document.keys).length) await this.write(document);
      else {
        await this.options.secrets.delete('device-key');
        if (await this.options.secrets.get('device-key') !== undefined) throw new HelperError('SECRET_STORE_FAILED', 'The helper could not verify device key removal.');
      }
    });
  }
}
