import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(__dirname, "../.github/workflows/ci.yml");

type WorkflowStep = {
  uses?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowJob = {
  name?: string;
  needs?: string | string[];
  if?: string;
  "runs-on": string;
  steps: WorkflowStep[];
};

type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

describe("CI workflow structure", () => {
  let workflow: Workflow;

  beforeAll(() => {
    const raw = readFileSync(WORKFLOW_PATH, "utf8");
    workflow = yaml.load(raw) as Workflow;
  });

  it("parses as valid YAML", () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe("object");
  });

  it("has correct trigger events", () => {
    const triggers = Object.keys(workflow.on);
    expect(triggers).toContain("push");
    expect(triggers).toContain("pull_request");
  });

  it("requires packages:write permission for publishing", () => {
    expect(workflow.permissions).toBeDefined();
    expect(workflow.permissions["packages"]).toBe("write");
  });

  it("defines a build-and-test job", () => {
    expect(workflow.jobs["build-and-test"]).toBeDefined();
  });

  it("build-and-test job includes install, build, and test steps", () => {
    const steps = workflow.jobs["build-and-test"]!.steps;
    const runCommands = steps
      .filter((s) => s.run !== undefined)
      .map((s) => s.run!);
    expect(runCommands).toContain("npm ci");
    expect(runCommands).toContain("npm run build");
    expect(runCommands).toContain("npm test");
  });

  it("defines a publish job", () => {
    expect(workflow.jobs["publish"]).toBeDefined();
  });

  it("publish job depends on build-and-test", () => {
    const publishJob = workflow.jobs["publish"]!;
    const needs = Array.isArray(publishJob.needs)
      ? publishJob.needs
      : [publishJob.needs];
    expect(needs).toContain("build-and-test");
  });

  it("publish job only runs on push to main", () => {
    const publishJob = workflow.jobs["publish"]!;
    expect(publishJob.if).toContain("refs/heads/main");
    expect(publishJob.if).toContain("push");
  });

  it("publish job uses NODE_AUTH_TOKEN from GITHUB_TOKEN secret", () => {
    const publishStep = workflow.jobs["publish"]!.steps.find(
      (s) => s.run?.includes("npm publish"),
    );
    expect(publishStep).toBeDefined();
    expect(publishStep!.env?.["NODE_AUTH_TOKEN"]).toContain("GITHUB_TOKEN");
  });

  it("publish job configures GitHub Packages registry and scope", () => {
    const setupStep = workflow.jobs["publish"]!.steps.find(
      (s) => s.uses?.startsWith("actions/setup-node"),
    );
    expect(setupStep).toBeDefined();
    expect(setupStep!.with?.["registry-url"]).toBe(
      "https://npm.pkg.github.com",
    );
    expect(setupStep!.with?.["scope"]).toBe("@quickdeployai");
  });
});
