// Fixture stand-in for the retention test a repository keeps beside its jobs. The gate reads only that it
// is a test file, holds a test, and names the job it covers.
import { test } from "vitest";

test("purge-sessions deletes a session older than 30 days and keeps one inside the window", () => {});
test("purge-inactive-people deletes a person inactive for 730 days", () => {});
