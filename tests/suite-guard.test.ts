import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const minimums = {
  "architecture.test.ts": 1,
  "cli-stages.test.ts": 6,
  "cli.test.ts": 11,
  "counts.test.ts": 6,
  "console-status.test.ts": 15,
  "console-page.test.ts": 8,
  "console-actions.test.ts": 11,
  "console-replicas.test.ts": 6,
  "setup.test.ts": 11,
  "setup-wizard.test.ts": 6,
  "deletions.test.ts": 9,
  "deployment-verify.test.ts": 8,
  "reconcile.test.ts": 14,
  "object-coverage.test.ts": 8,
  "object-selection.test.ts": 10,
  "run-lock.test.ts": 13,
  "oauth-tokens.test.ts": 7,
  "oauth-login-mode.test.ts": 8,
  "auth-cli.test.ts": 18,
  "deployment-init.test.ts": 6,
  "replica-store-adversarial.test.ts": 30,
  "replica-store.test.ts": 5,
  "salesforce.test.ts": 3,
  "scripts-reachability.test.ts": 2,
  "semantic-contract.test.ts": 7,
  "suite-guard.test.ts": 5,
};

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

function readTest(name: string): ts.SourceFile {
  return parse(name, readFileSync(new URL(name, import.meta.url), "utf8"));
}

function callsIn(root: ts.Node, ...names: string[]): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return calls;
}

function imports(file: ts.SourceFile, moduleName: string, namedImport?: string): boolean {
  return file.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleName || statement.importClause?.isTypeOnly) return false;
    if (!namedImport) return true;
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some(
      (binding) => !binding.isTypeOnly && !binding.propertyName && binding.name.text === namedImport,
    );
  });
}

const helperName = "helpers/replica-store-contract.ts";
const contractModule = "./helpers/replica-store-contract.js";
const contractName = "replicaStoreContractTests";

function contractCaseCount(helper: ts.SourceFile): number {
  const declaration = helper.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === contractName,
  );
  assert.ok(declaration?.body, `Missing ${contractName} body`);
  return callsIn(declaration.body, "contract").length;
}

function registrationCount(file: ts.SourceFile, contractCases: number): number {
  const direct = imports(file, "node:test") ? callsIn(file, "test", "it").length : 0;
  const contracts = imports(file, contractModule, contractName) ? callsIn(file, contractName).length : 0;
  return direct + contracts * contractCases;
}

test("npm test uses the offline runner without a pretest hook", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(scripts.test, "node scripts/offline-suite.mjs");
  assert.equal(Object.hasOwn(scripts, "pretest"), false);
});

test("the suite manifest matches every top-level test file", () => {
  const actual = readdirSync(new URL("./", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, Object.keys(minimums).sort());
});

test("each test file retains its minimum static registration count", () => {
  const contractCases = contractCaseCount(readTest(helperName));
  for (const [name, minimum] of Object.entries(minimums)) {
    const count = registrationCount(readTest(name), contractCases);
    assert.ok(count >= minimum, `${name}: expected at least ${minimum} registrations, found ${count}`);
  }
});

test("the replica store contract registers node:test cases for memory and postgres", () => {
  const helper = readTest(helperName);
  assert.ok(imports(helper, "node:test"));
  assert.ok(contractCaseCount(helper) >= 15);
  const adversarial = readTest("replica-store-adversarial.test.ts");
  assert.ok(imports(adversarial, contractModule, contractName));
  for (const backend of ["memory", "postgres"]) {
    assert.ok(callsIn(adversarial, contractName).some(({ arguments: [name] }) =>
      name !== undefined && ts.isStringLiteralLike(name) && name.text === backend,
    ), `Missing ${backend} contract registration`);
  }
});

test("the standalone runner check registers success and failure tests", () => {
  assert.ok(registrationCount(readTest("offline-suite-runner.check.ts"), 0) >= 2);
});
