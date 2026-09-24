/**
 * Optional peer packages: the database drivers and service clients an
 * APPLICATION installs, never the framework (ADR-0067).
 *
 * tina4-nodejs installs as exactly one package. `pg`, `mongodb`, `redis` and
 * the `@aws-sdk` S3 client are optional peerDependencies, which npm does not
 * install, so for most apps "missing" is the normal state. Every feature that
 * reaches for one must therefore fail at the point of use with the exact
 * command that fixes it - never a bare MODULE_NOT_FOUND, never a silent no-op.
 */

/** The actionable "install it" error, one wording for every optional peer. */
export function optionalPackageMissing(feature: string, packageNames: string[]): Error {
  const quoted = packageNames.map((name) => `'${name}'`).join(" and ");
  const [noun, pronoun] = packageNames.length === 1 ? ["package is", "it"] : ["packages are", "them"];
  return new Error(
    `The ${quoted} ${noun} required for ${feature}. ` +
      `Install ${pronoun} with: npm install ${packageNames.join(" ")}`,
  );
}

/**
 * Resolve an optional peer from the FRAMEWORK's location and return its module
 * URL, or throw the actionable error. Synchronous, so a constructor can refuse
 * immediately (parity with the Python master, which raises ImportError in the
 * constructor) instead of leaving a rejected promise for later.
 *
 * Resolving from here rather than from process.cwd() is what finds the peer an
 * app installed, wherever the server was started from.
 *
 * @param installTogether packages the feature needs as a set (S3 needs the
 *   client AND the presigner), all named in the one install command.
 */
export function resolveOptionalPackage(packageName: string, feature: string, installTogether: string[] = [packageName]): string {
  try {
    return import.meta.resolve(packageName);
  } catch {
    throw optionalPackageMissing(feature, installTogether);
  }
}
