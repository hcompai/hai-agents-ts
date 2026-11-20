// Drift fixture: the mirror of test_mod.py; not run by vitest (it is not *.test.ts at the package root).
it("one thing", () => {});
it.each<[number, string]>([
  [1, "a (b)"],
  [2, "c"],
])("rows thing [%s %s]", () => {});
it("renamed thing in ts", () => {});
it("extra thing", () => {});
it.skip("skipped thing", () => {});
it.todo("todo thing");
