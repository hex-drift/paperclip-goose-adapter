import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "scripts/motor-report-mcp.py"
spec = importlib.util.spec_from_file_location("motor_mcp", SCRIPT)
assert spec is not None and spec.loader is not None
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)

CID = "11111111-1111-4111-8111-111111111111"
AID = "22222222-2222-4222-8222-222222222222"
IID = "33333333-3333-4333-8333-333333333333"
RID = "44444444-4444-4444-8444-444444444444"


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        skills = self.root / CID / "skills"
        scripts = skills / "mia3-lib--test/scripts"
        scripts.mkdir(parents=True)
        (scripts / "mia.py").write_text("# fake toolkit\n")
        (self.root / "motor-bonus-daily.py").write_text("# fake report\n")
        scratch = self.root / RID / "scratch"
        scratch.mkdir(parents=True)
        self.env = {"BRAND_SLUG": "motor", "BRAND_DB": "chr_NextCode2", "BRAND_PARTNER_ID": "100",
                    "PAPERCLIP_COMPANY_ID": CID, "PAPERCLIP_AGENT_ID": AID, "PAPERCLIP_TASK_ID": IID,
                    "PAPERCLIP_RUN_ID": RID, "PAPERCLIP_SKILLS_ROOT": str(skills), "MIA": str(scripts / "mia.py"),
                    "MIA_BONUS_DAILY": str(self.root / "motor-bonus-daily.py"), "PAPERCLIP_RUN_SCRATCH_DIR": str(scratch)}
        self.issue = {"id": IID, "companyId": CID, "assigneeAgentId": AID, "status": "in_progress",
                      "executionRunId": RID, "title": "bonus", "description": "One UTC day"}
        self.comments = [{"id": "comment-1", "issueId": IID, "companyId": CID, "authorType": "user",
                          "createdAt": "2026-09-25T00:00:00Z", "body": "24 September"}]

    def tearDown(self):
        self.temp.cleanup()

    def test_strict_schema_rejects_sql_scope_path_and_bad_date_before_execution(self):
        for args in [{"date": "2026-02-30"}, {"date": "2026-09-24; env"}, {"date": "2026-09-24", "sql": "SELECT 1"},
                     {"date": "2026-09-24", "issueId": IID}, {"date": "2026-09-24", "script": "/tmp/other.py"}, {}]:
            with self.subTest(args=args), patch.object(mcp, "command") as cmd:
                with self.assertRaises(mcp.ToolFailure):
                    mcp.prepare(args, self.env)
                cmd.assert_not_called()

    def test_binding_rejects_another_brand_and_outside_paths(self):
        for env in [{**self.env, "BRAND_PARTNER_ID": "8"}, {**self.env, "PAPERCLIP_COMPANY_ID": AID},
                    {**self.env, "PAPERCLIP_RUN_ID": AID}, {**self.env, "MIA_BONUS_DAILY": self.env["MIA"]}]:
            with self.assertRaises(mcp.ToolFailure):
                mcp.run_binding(env)

    def test_context_requires_correct_issue_agent_and_full_comment_list(self):
        for issue, comments in [({**self.issue, "companyId": AID}, []), ({**self.issue, "assigneeAgentId": CID}, []),
                                ({**self.issue, "status": "done"}, []), (self.issue, {"items": [], "nextCursor": "more"}),
                                (self.issue, [{**self.comments[0], "issueId": AID}])]:
            with patch.object(mcp, "api_get", side_effect=[issue, comments]):
                with self.assertRaises(mcp.ToolFailure):
                    mcp.read_context(self.env)

    def fake_command(self, calls):
        def call(argv, env, directory, name, deadline):
            calls.append((name, argv, env))
            self.assertEqual(env["PAPERCLIP_RUN_ID"], RID)
            if name == "report":
                self.assertEqual(argv[-2:], ["--date", "2026-09-24"])
                out = directory / "bonus-daily"
                out.mkdir()
                (out / "report.json").write_text(json.dumps({"date": "2026-09-24", "timezone": "UTC", "all_checks_pass": True}))
            return "memory evidence" if name == "memory" else "ok"
        return call

    def test_success_has_only_read_operations_and_no_automatic_publication(self):
        calls = []
        with patch.object(mcp, "api_get", side_effect=[self.issue, self.comments, self.issue, self.comments]), \
             patch.object(mcp, "command", side_effect=self.fake_command(calls)):
            result = mcp.prepare({"date": "2026-09-24"}, self.env)
        self.assertEqual([c[0] for c in calls], ["profile", "memory", "report"])
        self.assertTrue(result["ready_for_review"])
        self.assertFalse(result["publication"]["performed"])
        self.assertEqual(result["context"]["messages"][0]["authorType"], "user")
        self.assertEqual(set(result["timings_seconds"]), {"thread", "profile", "memory", "report", "context_recheck"})
        self.assertTrue(Path(result["publication"]["scratch_directory"]).is_relative_to(Path(self.env["PAPERCLIP_RUN_SCRATCH_DIR"])))

    def test_new_user_direction_requires_review(self):
        changed = [{**self.comments[0], "body": "Actually 23 September"}]
        with patch.object(mcp, "api_get", side_effect=[self.issue, self.comments, self.issue, changed]), \
             patch.object(mcp, "command", side_effect=self.fake_command([])):
            result = mcp.prepare({"date": "2026-09-24"}, self.env)
        self.assertFalse(result["ready_for_review"])
        self.assertTrue(result["context_changed_during_report"])
        self.assertEqual(result["context"]["messages"][0]["body"], "Actually 23 September")

    def test_guard_failure_prevents_report_and_redacts_errors(self):
        calls = []
        def fail(argv, env, directory, name, deadline):
            calls.append(name)
            raise mcp.ToolFailure("profile_failed")
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "prepare_bonus_report", "arguments": {"date": "2026-09-24"}}}
        with patch.object(mcp, "api_get", side_effect=[self.issue, self.comments]), patch.object(mcp, "command", side_effect=fail):
            response = mcp.dispatch(request, lambda args: mcp.prepare(args, self.env))
        self.assertEqual(calls, ["profile"])
        self.assertTrue(response["result"]["isError"])
        def secret_error(args):
            raise RuntimeError("password=hunter-secret url=https://internal")
        self.assertNotIn("hunter-secret", json.dumps(mcp.dispatch(request, secret_error)))

    def test_stdio_protocol_smoke_without_credentials(self):
        messages = ["not json", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}),
                    json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                    json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                    json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "prepare_bonus_report", "arguments": {"date": "invalid"}}})]
        proc = subprocess.run([sys.executable, str(SCRIPT)], input="\n".join(messages) + "\n", capture_output=True, text=True, timeout=5)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(len(rows), 4)  # notifications do not get a response
        self.assertEqual(rows[0]["error"]["code"], -32700)
        self.assertEqual(rows[1]["result"]["protocolVersion"], "2025-03-26")
        self.assertEqual(rows[2]["result"]["tools"][0]["inputSchema"]["additionalProperties"], False)
        self.assertTrue(rows[3]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
