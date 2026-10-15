// TLS-12's verified export sets RELEASE to true in the public release artifact.
// Source-only overrides must never be enabled in a release artifact.
export const RELEASE = true;
export const VERSION = '0.1.0';

export interface ReleaseIdentity {
  repository: string;
  workflowPath: string;
  allowedSigner: string;
  releasePrefix: 'helper-';
  assetName: 'helper.tgz';
}

// TLS-40 supplies these trust roots through the reviewed export command.
export const RELEASE_IDENTITY: Readonly<ReleaseIdentity> | null = Object.freeze({
  "repository": "sergiuliano/maddots-ai-releases",
  "workflowPath": ".github/workflows/helper-release.yml",
  "allowedSigner": "sergiuliano namespaces=\"git\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIRSFnznywnHjMXqQnEA4nbVU7RW4X30NAP1dDmDRxtr",
  "releasePrefix": "helper-",
  "assetName": "helper.tgz"
});
