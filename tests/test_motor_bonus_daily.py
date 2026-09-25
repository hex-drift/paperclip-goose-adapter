import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("report", pathlib.Path(__file__).parents[1] / "scripts/motor-bonus-daily.py")
assert spec is not None and spec.loader is not None
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def test_queries_are_date_parameterized_and_brand_scoped(self):
        queries = report.statements("2026-09-24")
        self.assertEqual(len(queries), 4)
        for sql in queries.values():
            self.assertTrue(sql.startswith("SELECT"))
            self.assertIn("PartnerId=100", sql)
            self.assertIn("2026-09-24", sql)
        self.assertIn("2026-09-25", queries["by_program"])
        self.assertIn("AwardingTime", queries["by_program"])
        self.assertIn("IsTest=0", queries["by_program"])
        with self.assertRaises(ValueError):
            report.statements("2026-09-24'; DROP TABLE x")

    def test_parse_requires_complete_toolkit_rows(self):
        self.assertEqual(report.parse_rows('rows returned: 1\npartner-checked rows: 1\n[{"n":42}]'), [{"n":42}])
        for value in ('DRY RUN', 'rows returned: 1000\n[]', 'rows returned: 2\n[]'):
            with self.assertRaises(RuntimeError):
                report.parse_rows(value)


if __name__ == "__main__":
    unittest.main()
