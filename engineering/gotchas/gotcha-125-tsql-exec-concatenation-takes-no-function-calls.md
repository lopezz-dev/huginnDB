---
id: 125
type: gotcha
status: active
date: 2026-10-29
tags: [mssql, tsql]
related: [123]
supersedes: []
superseded_by: null
amends: []
---

# Gotcha #125: T-SQL's `EXEC(…)` concatenates only literals and variables — `EXEC(N'…' + QUOTENAME(@n))` does not parse

The dynamic-SQL form of `EXEC` takes a string built from literals and variables joined with `+`, and nothing else. A function call inside it, the natural `EXEC(N'ALTER TABLE t DROP CONSTRAINT ' + QUOTENAME(@name))`, is a syntax error. SQL Server reports it at parse time, so the whole batch is refused. Build the statement into a variable first and run that.

**Trap:** a dynamic `EXEC(… + QUOTENAME(@x))` fails with "Incorrect syntax near 'QUOTENAME'", and string-comparing unit tests cannot see it.

## Detail

- **Symptom:** `Incorrect syntax near 'QUOTENAME'.` (error 102, state 1), on the line holding the `EXEC(`. Nothing in the batch runs, the lookup before it included.
- **Cause:** the `EXECUTE` grammar for a character string is `EXEC ( { @string_variable | [N]'tsql_string' } [ + …n ] )` ([docs](https://learn.microsoft.com/sql/t-sql/language-elements/execute-transact-sql)). Expressions, function calls included, are not allowed between the parentheses.
- **What to do:** `DECLARE @sql nvarchar(max) = N'…' + QUOTENAME(…); IF @sql IS NOT NULL EXEC sp_executesql @sql`. That is the shape of `db::ddl::mssql_drop_named_constraint`, behind every default and primary-key drop the T-SQL structure builder emits (ADR #123). `QUOTENAME(NULL)` is `NULL`, which is what makes the `IF` the "nothing to drop" case.
- **How it was found:** the T-SQL builder first shipped with the `EXEC(…)` form and string-only unit tests (PR #287). The first run against a real SQL Server 2016 rejected every change that dropped a default or a key. Any new dynamic T-SQL should get one run against a server before it is trusted.
- **Retire when:** never; it is the language's grammar.
