/**
 * Executable schema + the generic "schema-valid empty" layer.
 *
 * The SDL (schema.graphql) is the FULL app schema: shop, recipes, discover,
 * content, promotions, etc. Only a small core has real resolvers (auth +
 * foodgroups + a couple of user-scoped examples). Everything else is handled
 * AFTER the schema is built by two generic passes, mirroring the Python
 * reference (backend-py/app.py):
 *
 *   (a) type_resolver on every union AND interface, so abstract fields never
 *       crash for lack of a __typename discriminator.
 *   (b) a default resolver on every field that has NO explicit resolver, which
 *       returns a SCHEMA-VALID EMPTY value:
 *         - null for any nullable field (nullable lists included),
 *         - [] for non-null list types,
 *         - the zero scalar ("" / 0 / false) for non-null leaf scalars,
 *         - the first enum value for non-null enums,
 *         - and for a non-null object/interface/union, a minimal {} whose own
 *           required non-null subfields recurse through the same logic.
 *
 * The effect: shop/recipe/content/promotion operations resolve to empty data
 * instead of erroring, exactly like the discontinued upstream services would
 * appear "empty" rather than "broken".
 */

import { makeExecutableSchema } from "@graphql-tools/schema";
import {
  defaultFieldResolver,
  type GraphQLResolveInfo,
  GraphQLScalarType,
  type GraphQLSchema,
  type GraphQLType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  Kind,
} from "graphql";
import typeDefs from "../schema.graphql";
import { resolvers } from "./resolvers";

// ── custom scalars ──────────────────────────────────────────────────────────
const DateScalar = new GraphQLScalarType({
  name: "Date",
  description: "Unix-seconds internally; serialized as an ISO-8601 string.",
  serialize(value) {
    if (value == null) return null;
    if (typeof value === "number") {
      const ms = value > 1e12 ? value : value * 1000; // tolerate ms or seconds
      return new Date(ms).toISOString();
    }
    return String(value);
  },
  parseValue(value) {
    return value;
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.INT) return parseInt(ast.value, 10);
    if (ast.kind === Kind.STRING) return ast.value;
    return null;
  },
});

const UrlScalar = new GraphQLScalarType({
  name: "Url",
  serialize: (v) => (v == null ? null : String(v)),
  parseValue: (v) => v,
  parseLiteral: (ast) => ("value" in ast ? ast.value : null),
});

const UnknownScalar = new GraphQLScalarType({
  name: "Unknown",
  description: "Opaque passthrough (the real type was lost during introspection).",
  serialize: (v) => (v === undefined ? null : v),
  parseValue: (v) => v,
  parseLiteral: (ast) => ("value" in ast ? ast.value : null),
});

const scalarResolvers = {
  Date: DateScalar,
  Url: UrlScalar,
  Unknown: UnknownScalar,
};

// ── the empty layer ─────────────────────────────────────────────────────────
const SCALAR_ZERO: Record<string, unknown> = {
  Int: 0,
  Float: 0,
  Boolean: false,
  String: "",
  ID: "",
  Date: 0,
  Url: "",
  Unknown: "",
};

/** A schema-valid empty value for a return type. Nullable -> null. */
function zeroForType(type: GraphQLType): unknown {
  if (isNonNullType(type)) {
    const inner = type.ofType;
    if (isListType(inner)) return [];
    if (isScalarType(inner)) return SCALAR_ZERO[inner.name] ?? "";
    if (isEnumType(inner)) return inner.getValues()[0]?.value ?? null;
    // object / interface / union -> minimal object; children recurse via their
    // own fill resolvers (interfaces/unions also carry a type_resolver).
    return {};
  }
  // nullable (lists included) -> null is always valid
  return null;
}

function fillResolver(
  parent: unknown,
  args: Record<string, unknown>,
  ctx: unknown,
  info: GraphQLResolveInfo,
): unknown {
  const val = defaultFieldResolver(parent, args, ctx, info);
  if (val !== undefined && val !== null) return val;
  return zeroForType(info.returnType);
}

function abstractTypeResolver(schema: GraphQLSchema, type: GraphQLType) {
  const possible = schema.getPossibleTypes(type as never);
  const fallback = possible[0]?.name ?? undefined;
  return (obj: unknown): string | undefined => {
    if (obj && typeof obj === "object" && "__typename" in obj) {
      const tn = (obj as { __typename?: unknown }).__typename;
      if (typeof tn === "string" && tn) return tn;
    }
    return fallback;
  };
}

/**
 * Install (a) type resolvers on unions/interfaces and (b) fill resolvers on
 * every field lacking an explicit one. Mutates the schema in place. Runs AFTER
 * real resolvers are bound, so nothing explicit is overridden.
 */
export function installEmptyLayer(schema: GraphQLSchema): GraphQLSchema {
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith("__")) continue;

    if (isUnionType(type) || isInterfaceType(type)) {
      if (!type.resolveType) type.resolveType = abstractTypeResolver(schema, type);
    }

    if (isObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        if (!field.resolve) field.resolve = fillResolver;
      }
    }
  }
  return schema;
}

// ── build ───────────────────────────────────────────────────────────────────
export const schema: GraphQLSchema = installEmptyLayer(
  makeExecutableSchema({
    typeDefs,
    resolvers: [resolvers as never, scalarResolvers],
  }),
);
