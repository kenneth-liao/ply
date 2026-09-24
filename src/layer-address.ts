/**
 * Layer name addressing (spec #226 US-003, DEC-003): the ONE boundary where a
 * Composition-plus-use name address resolves into a Layer id. Every
 * id-accepting command reaches this module at its CLI entry point; nothing
 * downstream ever learns that an address existed.
 *
 * The address form is `<composition>/<use>`: the Composition's name, a slash,
 * and the use's local name. It is unambiguous against Layer ids (a Layer id
 * is `layer_…` and can never contain a slash) and needs no shell quoting
 * (letters, digits, dash, underscore, and the slash — no spaces or shell
 * metacharacters). A slash anywhere in the token always means an address.
 */
import { resolveProjectRoot } from "./project.js";
import { readCompositionDocument } from "./composition.js";

/** A parsed Composition-plus-use address. */
export interface LayerAddress {
  composition: string;
  use: string;
}

/** A token that LOOKS like an address (contains a slash) but is not a
 * well-formed one. A usage error (exit 2) at the command boundary, distinct
 * from the semantic unknown-name refusals (exit 1). */
export class LayerAddressSyntaxError extends Error {}

/** The one name rule for Composition and use names (see sanitizeName). */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Parse the command's Layer token. Returns the parsed address when the token
 * contains a slash (the address marker), or undefined when the token is a
 * plain Layer id — which passes through unchanged. A slash-bearing token that
 * is not a well-formed `<composition>/<use>` throws a usage error.
 */
export function parseLayerAddress(token: string): LayerAddress | undefined {
  if (!token.includes("/")) {
    return undefined;
  }
  const parts = token.split("/");
  const [composition, use] = parts as [string | undefined, string | undefined];
  if (
    parts.length !== 2 ||
    composition === undefined ||
    use === undefined ||
    !NAME_PATTERN.test(composition) ||
    !NAME_PATTERN.test(use)
  ) {
    throw new LayerAddressSyntaxError(
      `Invalid Layer address "${token}": an address is "<composition>/<use>" — the Composition's name, a single slash, ` +
        `and the use's local name (alphanumeric, dash, or underscore).`,
    );
  }
  return { composition, use };
}

/** A resolved command target: the Layer id everything downstream works with,
 * plus the parsed address when the caller used one. */
export interface ResolvedLayerToken {
  layerId: string;
  address?: LayerAddress;
}

/**
 * The ONE resolution boundary (DEC-003): turn the command's Layer token into
 * a Layer id. A plain Layer id passes through unchanged; an address resolves
 * through its Composition's use. An unknown Composition or use is refused
 * naming what exists; a well-formed address to a dangling Layer reference
 * resolves to the stored id and is failed by the ordinary Layer readers.
 * Read-only: nothing here publishes anything.
 */
export async function resolveLayerToken(
  projectPath: string,
  token: string,
): Promise<ResolvedLayerToken> {
  const address = parseLayerAddress(token);
  if (address === undefined) {
    return { layerId: token };
  }

  const resolvedRoot = await resolveProjectRoot(projectPath);
  const { comp } = await readCompositionDocument(resolvedRoot, address.composition);
  const use = comp.layers.find((l) => l.name === address.use);
  if (!use) {
    const listing =
      comp.layers.length === 0
        ? "The Composition has no Layer uses."
        : `Existing uses: ${comp.layers.map((l) => `"${l.name}"`).join(", ")}.`;
    throw new Error(
      `Use "${address.use}" not found in composition "${address.composition}". ${listing}`,
    );
  }
  return { layerId: use.layerId, address };
}
