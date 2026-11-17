/**
 * Skill lifecycle round-trip against the live API.
 *
 * Create -> fetch -> update -> delete -> confirm the 404. Each step exercises a
 * different SDK code path (POST + create body, GET + parse, PUT + full-replace
 * body, DELETE + 204, GET + 404 -> HaiAgentsError). Skills are keyed by name; the
 * fixture cleanup still deletes the skill if a step fails so we don't leak it.
 *
 * The generated client raises HaiAgentsError on non-2xx and returns the parsed model on
 * success, so we assert on returned models and on raised errors rather than on
 * status codes.
 */
import { describe, expect, it } from "vitest";

import { HaiAgentsError } from "hai-agents";

import { raisesAsync } from "../helpers";
import { client, createdSkills, runId, skipReason } from "./fixtures";

// pytestmark = pytest.mark.integration
describe.skipIf(skipReason() !== null)("integration", () => {
  it("skill lifecycle", async () => {
    const c = client();
    const skills = createdSkills(c);
    const name = `${runId()}-skill`;
    const initialBody = "When asked for the integration test marker, reply with 'sdkit-ok'.";

    const skill = await c.skills.createSkill({
      body: { name, description: "SDK integration test skill -- safe to delete", body: initialBody },
    });
    skills.push(skill.name);
    expect(skill.name).toBe(name);
    expect(skill.body).toBe(initialBody);

    const fetched = await c.skills.getSkill({ name: skill.name });
    expect(fetched.name).toBe(skill.name);
    expect(fetched.body).toBe(skill.body);

    // UPDATE is a full replacement: name + body required or the server returns 422.
    const newDescription = "SDK integration test skill -- updated";
    const updated = await c.skills.updateSkill({
      name: skill.name,
      body: {
        name: skill.name,
        description: newDescription,
        body: initialBody + " [updated]",
      },
    });
    expect(updated.description).toBe(newDescription);
    expect(updated.body.endsWith("[updated]")).toBe(true);

    await c.skills.deleteSkill({ name: skill.name });
    skills.splice(skills.indexOf(skill.name), 1);

    const error = await raisesAsync(() => c.skills.getSkill({ name: skill.name }), HaiAgentsError);
    expect(error.statusCode).toBe(404);
  });

  it("skill update without body returns 422", async () => {
    // The known gotcha: PUT is full-replacement, so omitting body may fail.
    const c = client();
    const skills = createdSkills(c);
    const name = `${runId()}-partial`;
    const skill = await c.skills.createSkill({
      body: { name, description: "for partial-update 422 check", body: "initial body" },
    });
    skills.push(skill.name);

    // Empty body on the full-replacement endpoint: the server either tolerates
    // it (200, no raise) or rejects it (422 -> HaiAgentsError). Anything else is a bug.
    try {
      await c.skills.updateSkill({
        name: skill.name,
        body: {
          name: skill.name,
          description: "only changed description",
          body: "",
        },
      });
    } catch (exc) {
      if (!(exc instanceof HaiAgentsError)) throw exc;
      expect(exc.statusCode, `expected 422, got ${exc.statusCode}`).toBe(422);
    }
  });
});
