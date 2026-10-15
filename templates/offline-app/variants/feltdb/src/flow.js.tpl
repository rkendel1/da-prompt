// feltdb.flow (at the project root) is the application's data model and its single authority: the store refuses to open
// unless the flow parses and validates, deploys it into FeltDB (versioned; a destructive change is refused), checks that the
// active contract is exactly this file's, and checks every record against it before writing.
//
// FeltDB 0.11.9's local runtime records the deployed model but does not check records against it (an undeclared collection,
// a missing or ill-typed field and an undeclared field are all accepted), so the record check below is the application's,
// derived from the parsed flow and nothing else. Declare a new field or collection in feltdb.flow, not here.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFlowSpec, validateFlowSpec, compileApplicationContract } from '@feltdb/core';

export const FLOW_FILE = fileURLToPath(new URL('../feltdb.flow', import.meta.url));

export class FlowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlowError';
  }
}

/** Parse and validate the flow. Throws FlowError (fail closed) when it is missing or invalid. */
export function loadFlow(file = FLOW_FILE) {
  let spec;
  try {
    spec = parseFlowSpec(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new FlowError(`feltdb.flow cannot be read: ${err.message}`);
  }
  const errors = validateFlowSpec(spec).filter((d) => d.severity === 'error');
  if (errors.length) throw new FlowError(`feltdb.flow is invalid: ${errors.map((d) => d.message).join('; ')}`);
  return spec;
}

/** Make the flow the active model of the store: deploy it when the active contract differs, then require an exact match. */
export async function deployFlow(db, spec) {
  const contract = await compileApplicationContract(spec, 'local', spec.app);
  const hash = contract.hashes.application;
  let active = null;
  try {
    active = await db.application.get();
  } catch {
    /* nothing deployed yet */
  }
  if (active?.contract_hash !== hash) {
    try {
      await db.deployFlowSpec(spec); // refuses a destructive change (a removed collection or field) without approval
    } catch (err) {
      throw new FlowError(`feltdb.flow could not be deployed: ${err.message}`);
    }
    active = await db.application.get();
  }
  if (active.contract_hash !== hash) throw new FlowError(`the store's active model (${active.contract_hash}) is not feltdb.flow (${hash})`);
  return { version: active.version, hash };
}

const TYPES = {
  text: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  datetime: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  json: (v) => v !== undefined,
};

/** A record check derived from the flow: (collection, record) => record, or a FlowError naming the violation. */
export function recordCheck(spec) {
  const models = new Map(spec.collections.map((c) => [c.name, c]));
  return (collection, record) => {
    const model = models.get(collection);
    if (!model) throw new FlowError(`collection ${collection} is not declared in feltdb.flow`);
    const fields = new Map(model.fields.map((f) => [f.name, f]));
    for (const key of Object.keys(record)) if (key !== 'id' && !fields.has(key)) throw new FlowError(`${collection}.${key} is not declared in feltdb.flow`);
    for (const f of fields.values()) {
      const v = record[f.name];
      if (v === undefined || v === null) {
        if (!f.optional) throw new FlowError(`${collection}.${f.name} is required by feltdb.flow`);
        continue;
      }
      const check = TYPES[f.type];
      if (!check) throw new FlowError(`${collection}.${f.name}: type ${f.type} has no record check; add one in src/flow.js`);
      if (!check(v)) throw new FlowError(`${collection}.${f.name} must be ${f.type}`);
    }
    return record;
  };
}
