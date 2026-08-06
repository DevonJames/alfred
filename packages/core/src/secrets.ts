import type { SecretRef } from "@alfred/contracts";

export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

/**
 * Resolves SecretRef values. Encrypted storage is stubbed (not implemented in M1).
 */
export class SecretResolver {
  resolve(ref: SecretRef): string {
    switch (ref.kind) {
      case "env": {
        const value = process.env[ref.name];
        if (value === undefined || value === "") {
          throw new SecretResolutionError(
            `Environment variable '${ref.name}' is not set (SecretRef kind=env)`,
          );
        }
        return value;
      }
      case "localStub":
        return ref.stubValue;
      case "encrypted":
        throw new SecretResolutionError(
          `Encrypted secret storage is not implemented in M1 (keyId=${ref.keyId}). Use kind=env or localStub.`,
        );
      default: {
        const _exhaustive: never = ref;
        throw new SecretResolutionError(`Unknown SecretRef: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
