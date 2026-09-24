/******************************************************************************
 * GENERATED — do not edit. Run `bun run base:generate` instead.
 *
 * The base library sources, embedded so the CLI, the LSP server, and the
 * standalone executables all carry the library without an asset directory.
 * The files under `base/` are the source of truth.
 ******************************************************************************/

/** `base/data/function.tetaue` */
export const DATA_FUNCTION = `# Data.Function — the combinators that need no SQL at all.
#
# These are ordinary lambdas: the pure layer of the base library. Keeping
# them in their own module is what lets the Prelude stay a thin aggregator
# and lets a program import the whole Prelude without pulling in SQL.

export id = x => x
export const = x => y => x
export flip = f => x => y => f y x

# Composition (Control.Semigroupoid, PureScript-style): \`<<<\` is
# right-to-left like Haskell \`.\`, \`>>>\` is its flip.
export compose = f => g => x => g (f x)
export composeBack = f => g => x => f (g x)

# Point-free application, so \`f $ x\` reads like Haskell's \`$\`.
export apply = f => x => f x
`;

/** `base/data/maybe.tetaue` */
export const DATA_MAYBE = `# Data.Maybe — helpers over SQL NULL.
#
# \`(maybe T)\` is the language's Maybe: a value that may be SQL NULL. These
# are the derived predicates and eliminators the Prelude exposes unqualified
# (\`isNothing\`, \`isJust\`, \`fromMaybe\`). The constructors and eliminator come
# from the SQL surface; the derived predicates are ordinary base definitions.

import "../sql.tetaue" as sql

export isNothing: a -> bool = sql.isNull
export isJust = sql.maybeIsJust
export isNotNull: a -> bool = x => not ((sql.isNull) x)
`;

/** `base/prelude.tetaue` */
export const PRELUDE = `# The tetaue Prelude — auto-imported into every module that does not opt out
# with \`# no prelude\`.
#
# Like Haskell's \`Prelude\`, this module is a thin AGGREGATOR: the definitions
# live in ordinary base modules, and the Prelude re-exports the ones every
# program is expected to have in scope unqualified. Nothing is defined here
# beyond the handful of names that have no natural home elsewhere.
#
# The module is ordinary tetaue. It is parsed, inferred, and evaluated by the
# same pass as user code, so a local binding or an explicit import can shadow
# any of its names normally.
#
# NOTE: base modules are the only modules that see the primitive core
# unqualified. A user module reaches these names through this Prelude (or an
# explicit \`import "base/..."\`), never from a hidden global environment.

# A re-export adds names to THIS module's PUBLIC SURFACE but does not bind
# them locally, so the operator definitions below need a real import as well:
# \`import ... as sql\` gives the Prelude its own access to the same module.
import "./sql.tetaue" as sql
import "./sql.tetaue"
import "./sql/time.tetaue" as time
import "./data/function.tetaue" as fn

export * from "./data/function.tetaue"
export * from "./data/maybe.tetaue"
export * from "./sql.tetaue"
export * from "./sql/time.tetaue"

# ---------------------------------------------------------------------------
# Operators
#
# Infix PARSING and PRECEDENCE live in the grammar; the MEANING of an infix
# symbol is an ordinary curried binding named by surrounding it with
# underscores. Both \`1 + 2\` and \`_+_ 1 2\` resolve \`_+_\` from the current
# scope, so a local or imported operator binding overrides the default
# without touching the grammar or the evaluator.
#
# SQL-aware operators alias the library-internal primitives; pure operators
# are ordinary lambdas.
# ---------------------------------------------------------------------------

export _*_ = sql.sql_multiply
export _/_ = sql.sql_divide
export _+_ = sql.sql_add
export _-_ = sql.sql_subtract
export _<>_: string -> string -> string = x => y => concat [x, y]
export _<>_ = sql.sql_merge
export _==_ = sql.sql_equal
export _!=_ = sql.sql_not_equal
export _<_ = sql.sql_less_than
export _<=_ = sql.sql_less_than_or_equal
export _>_ = sql.sql_greater_than
export _>=_ = sql.sql_greater_than_or_equal
export _&&_ = sql.sql_and
export _||_ = sql.sql_or

export _>>>_ = fn.compose
export _<<<_ = fn.composeBack
export _?_ = x => d => fromMaybe d x
export _&_ = x => f => f x
export _$_ = fn.apply
export _<$>_ = fmap
export _<$_ = replaceWith
export _<*>_ = ap
export _<*_ = applyLeft
export _*>_ = applyRight
export _<|>_ = orElse
export _>>=_ = bind
export _>>_ = then
`;

/** `base/sql/time.tetaue` */
export const SQL_TIME = `# SQL date & time — the library's date layer, in ordinary tetaue.
#
# Every function here lowers to SQL through the vocabulary declared in
# \`../sql.tetaue\`:
#
#     sql_func name [args]      emit FUNC(args)
#     sql_infix op left right   emit \`left op right\`
#     sql_bare word             emit an unquoted SQL word
#     sql_fragment tpl [args]   emit \`tpl\` with each \`{}\` replaced (\`{:}\` bare)
#     sql_literal x             the SQL text of a literal argument, or ""
#     sql_literal_amount x s    the same, signed and scaled for an INTERVAL
#     sql_error msg             reject a definition (an unknown part/unit)
#     sql_dialect               the dialect record (branch on .name)
#
# Per-dialect variance is a \`case\` over \`sql_dialect.name\`. Evaluation
# constant-folds the branch — a literal \`==\` short-circuits and \`case\` picks
# the matching arm at analysis time — so exactly one SQL form is emitted and
# no CASE ever reaches the output. The same folding works for a \`case\` over an
# ordinary tetaue STRING parameter, which is how the date-part and date-unit
# arguments dispatch.
#
# This module is where the whole date/time layer lives — BOTH the per-dialect
# lowering and the accepted part/unit names, which are the dispatch arms below
# (an unknown name falls through to \`sql_error\`). The TypeScript core keeps
# only the four date/time CONSTANTS, which map to their own IR nodes.

# ---------------------------------------------------------------------------
# Private vocabulary
#
# Bound once so the definitions read as SQL. Unexported: the lowering
# primitives never leave the library, and neither do these aliases.
# ---------------------------------------------------------------------------

dialect = sql_dialect
fn = sql_func
op = sql_infix
bare = sql_bare
frag = sql_fragment
lit = sql_literal
lit_amount = sql_literal_amount
fail = sql_error

export year: a -> int = x => date_part "year" x

export month: a -> int = x => date_part "month" x

export day: a -> int = x => date_part "day" x

export dayOfWeek: a -> int = x => date_part "dayOfWeek" x

export hour: a -> int = x => date_part "hour" x

export minute: a -> int = x => date_part "minute" x

export second: a -> int = x => date_part "second" x

# \`extract x "quarter"\` is rejected by the DISPATCH below: the seven valid
# part names are its arms, and anything else reaches the trailing \`sql_error\`.
export extract: a -> string -> int = x => part => date_part part x

# The shared body for every date part. Each dialect spells a few parts
# differently, and sqlite has no EXTRACT at all:
#
#   sqlite     STRFTIME with a format, cast back to INTEGER
#   postgresql EXTRACT(field FROM x), with DOW for the day of the week
#   mysql      EXTRACT(field FROM x), with DAYOFWEEK for the day of the week
#   trino      EXTRACT(field FROM x), with DAY_OF_WEEK for the day of the week
#   hive       a bare part FUNCTION named after the part
#   _          ANSI EXTRACT(field FROM x)
date_part: string -> a -> int = part => x => case part {
    "year"      => dialect_part "year" x,
    "month"     => dialect_part "month" x,
    "day"       => dialect_part "day" x,
    "dayOfWeek" => dialect_part "dayOfWeek" x,
    "hour"      => dialect_part "hour" x,
    "minute"    => dialect_part "minute" x,
    "second"    => dialect_part "second" x,
    _           => fail extract_error,
}

# The per-dialect lowering of one KNOWN part. The part literal has already
# been checked by the dispatch above, so this function only chooses SQL.
dialect_part: string -> a -> int = part => x => case dialect.name {
    "sqlite"     => sqlite_part part x,
    "hive"       => hive_part part x,
    "mysql"      => mysql_part part x,
    "postgresql" => pg_part_sql part x,
    "trino"      => trino_part_sql part x,
    _            => ansi_part part x,
}

# sqlite has no EXTRACT: STRFTIME with a format, cast back to an integer.
sqlite_part: string -> a -> int = part => x => frag "CAST(STRFTIME({}, {}) AS INTEGER)" [sqlite_part_fmt part, x]

pg_part_sql: string -> a -> int = part => x => date_extract (pg_part part) x
trino_part_sql: string -> a -> int = part => x => date_extract (trino_part part) x
ansi_part: string -> a -> int = part => x => date_extract (part_upper part) x

# hive spells the day of the week as a function and every other part as a
# function named after it; mysql uses EXTRACT for every part but that one.
hive_part: string -> a -> int = part => x => case part {
    "dayOfWeek" => fn "DAYOFWEEK" [x],
    _           => fn (part_upper part) [x],
}

mysql_part: string -> a -> int = part => x => case part {
    "dayOfWeek" => fn "DAYOFWEEK" [x],
    _           => date_extract (part_upper part) x,
}

# The diagnostic for a part name that is not one of the seven. The accepted
# set is the dispatch arms in \`date_part\` above, so the two cannot drift.
extract_error = "extract expects a string literal — one of: year, month, day, dayOfWeek, hour, minute, second"

# One message per unit-taking function. The KNOWN unit names are the dispatch
# arms; reaching one of these means the name was not among them.
date_add_error = "dateAdd expects a string literal — one of: year, month, week, day, hour, minute, second"

date_diff_error = "dateDiff expects a string literal — one of: year, month, week, day, hour, minute, second"

date_trunc_error = "dateTrunc expects a string literal — one of: year, month, week, day, hour, minute, second"

# \`EXTRACT(field FROM x)\` — the one shape every dialect but sqlite/hive uses.

# ---------------------------------------------------------------------------
# Date parts
#
# \`year o.ts\`, \`month o.ts\`, ... and the generic \`extract o.ts "month"\`.
#
# The calendar type is an ordinary type VARIABLE: \`a -> int\` accepts any
# value, and the type it binds flows into the result. What the calendar type
# buys is THREADING — \`dateTrunc o.created_at "month"\` is a timestamp and
# \`dateTrunc o.order_date "month"\` a date — which is what makes comparing the
# former with CURRENT_DATE a type error (see test/dates.test.ts).
# ---------------------------------------------------------------------------

date_extract: string -> a -> int = field => x => fn "EXTRACT" [op "FROM" (bare field) x]

# \`dateAdd\`/\`dateDiff\` units as SQL keywords. The tetaue spelling is lower
# case (\`"day"\`); the unit keyword the dialects want is upper case.
unit_upper: string -> string = unit => case unit {
    "year"   => "YEAR",
    "month"  => "MONTH",
    "week"   => "WEEK",
    "day"    => "DAY",
    "hour"   => "HOUR",
    "minute" => "MINUTE",
    "second" => "SECOND",
    _        => "DAY",
}

# The part spellings. \`part_upper\` is the ANSI/EXTRACT keyword and doubles as
# hive's function name (\`YEAR(ts)\`); the sqlite form is a STRFTIME format.
part_upper: string -> string = part => case part {
    "year"      => "YEAR",
    "month"     => "MONTH",
    "day"       => "DAY",
    "dayOfWeek" => "DAYOFWEEK",
    "hour"      => "HOUR",
    "minute"    => "MINUTE",
    "second"    => "SECOND",
    _           => "DAY",
}

sqlite_part_fmt: string -> string = part => case part {
    "year"      => "%Y",
    "month"     => "%m",
    "day"       => "%d",
    "dayOfWeek" => "%w",
    "hour"      => "%H",
    "minute"    => "%M",
    "second"    => "%S",
    _           => "%Y",
}

pg_part: string -> string = part => case part {
    "dayOfWeek" => "DOW",
    _           => part_upper part,
}

trino_part: string -> string = part => case part {
    "dayOfWeek" => "DAY_OF_WEEK",
    _           => part_upper part,
}

# ---------------------------------------------------------------------------
# Adding and subtracting time
#
# \`dateAdd x "day" 7\` — value, unit, amount. The AMOUNT is the interesting
# case: a LITERAL amount has a native SQL spelling on every dialect
# (\`INTERVAL 7 DAY\`, \`DATETIME(x, '+7 days')\`), while a COMPUTED amount has to
# be parenthesized or built as an expression. \`lit\` (\`sql_literal\`) reports the
# literal's text and "" for a computed argument; the branches below pick their
# form from that, which is what keeps the decision in the library.
#
# The result keeps the input's calendar type: a date stays a date, a timestamp
# stays a timestamp (\`dateAdd currentDate "day" (-7)\` is a date).
# ---------------------------------------------------------------------------

export dateAdd: a -> string -> int -> a = x => unit => amount => date_add unit x amount

date_add: string -> a -> int -> a = unit => x => amount => case unit {
    "year"   => dialect_add "year" x amount,
    "month"  => dialect_add "month" x amount,
    "week"   => dialect_add "week" x amount,
    "day"    => dialect_add "day" x amount,
    "hour"   => dialect_add "hour" x amount,
    "minute" => dialect_add "minute" x amount,
    "second" => dialect_add "second" x amount,
    _        => fail date_add_error,
}

dialect_add: string -> a -> int -> b = unit => x => amount => case dialect.name {
    "postgresql" => postgres_add unit x amount,
    "mysql"      => mysql_add unit x amount,
    "sqlite"     => sqlite_add unit x amount,
    "hive"       => hive_add unit x amount,
    _            => frag "DATE_ADD({}, {}, {})" [unit, amount, x],
}

# One function per dialect: \`x + (n) * INTERVAL '1 day'\` is a FRAGMENT (a
# space-separated form the call/infix primitives cannot express), so each
# branch is written out here rather than inline in the dispatch above.
postgres_add: string -> a -> int -> b = unit => x => amount => frag "{} + ({}) * INTERVAL '1 {:}'" [x, amount, unit]

mysql_add: string -> a -> int -> b = unit => x => amount => frag "DATE_ADD({}, INTERVAL {} {:})" [x, amount, unit_upper unit]

sqlite_add: string -> a -> int -> b = unit => x => amount => frag "DATETIME({}, {})" [x, sqlite_modifier unit amount]

hive_add: string -> a -> int -> b = unit => x => amount => frag "{} + INTERVAL {} {:}" [x, hive_amount amount, unit_upper unit]

# The hive interval amount is a QUOTED literal when the amount is a literal
# and a parenthesized expression otherwise: \`INTERVAL '-7' DAY\` vs
# \`INTERVAL (n) DAY\`. The quotes come from \`{}\` in the template rather than
# from \`sql_func\`, because the amount here is a number and not a string
# argument (a number renders bare, without quotes).
hive_amount: int -> string = amount => case lit amount {
    "" => frag "({})" [amount],
    _  => frag "'{}'" [amount],
}

# The sqlite DATETIME modifier. A literal amount is signed by
# \`sql_literal_amount\` (a positive modifier needs an explicit \`+\`) and a week
# is folded to days; a computed amount becomes \`PRINTF('%+d days', ...)\`, so a
# column works exactly like a literal.
sqlite_modifier: string -> int -> string = unit => amount => case sqlite_scaled_literal unit amount {
    "" => sqlite_computed_modifier unit amount,
    _  => sqlite_literal_modifier unit amount,
}

sqlite_computed_modifier: string -> int -> string = unit => amount => frag "PRINTF({}, {})" [printf_unit unit, sqlite_printf_amount unit amount]

# The signed literal amount, already folded to days for a week. Split out so
# the \`case\` subject is a plain application: a parenthesized argument in the
# subject position of \`case\` parses as an application of the PREVIOUS argument
# (see the function-position-parens note in docs/design/sql-dialect.md).
sqlite_scaled_literal: string -> int -> string = unit => amount => scale_amount (week_scale unit) amount

# \`sql_literal_amount\` applied with the scale bound first: \`f x (g y)\` does not
# parse in tetaue (the parenthesized argument binds to the previous one), so
# the scale is passed as its own curried argument.
scale_amount: int -> int -> string = scale => amount => lit_amount amount scale

# The two concrete modifiers, one per amount kind. Splitting them avoids a
# \`case\` PATTERN that binds a value: a case branch is a literal pattern or the
# \`_\` fallback, so the scaled literal is re-derived here rather than captured.
sqlite_printf_amount: string -> int -> string = unit => amount => case unit {
    "week" => frag "({}) * 7" [amount],
    _      => frag "{}" [amount],
}

sqlite_literal_modifier: string -> int -> string = unit => amount => case unit {
    "week" => frag "'{:} days'" [lit_amount amount 7],
    _      => frag "'{:} {:}s'" [lit_amount amount 1, unit],
}

# \`%+d <unit>s\` — the sqlite PRINTF template for one unit. A week is folded to
# days before it reaches this table, so only the plain units appear.
printf_unit: string -> string = unit => case unit {
    "year"   => "%+d years",
    "month"  => "%+d months",
    "day"    => "%+d days",
    "hour"   => "%+d hours",
    "minute" => "%+d minutes",
    "second" => "%+d seconds",
    _        => "%+d days",
}

# How many days one unit is worth on sqlite, whose DATETIME modifier is
# day-granular for the scaled case.
week_scale: string -> int = unit => case unit {
    "week" => 7,
    _      => 1,
}

# \`dateDiff x "day" other\` — the elapsed time from x to other in units.
# Postgres and sqlite have no unit argument, so each unit is spelled out.
export dateDiff: a -> string -> b -> int = x => unit => other => date_diff unit x other

date_diff: string -> a -> b -> int = unit => x => other => case unit {
    "year"   => dialect_diff "year" x other,
    "month"  => dialect_diff "month" x other,
    "week"   => dialect_diff "week" x other,
    "day"    => dialect_diff "day" x other,
    "hour"   => dialect_diff "hour" x other,
    "minute" => dialect_diff "minute" x other,
    "second" => dialect_diff "second" x other,
    _        => fail date_diff_error,
}

dialect_diff: string -> a -> b -> int = unit => x => other => case dialect.name {
    "postgresql" => pg_diff unit x other,
    "mysql"      => mysql_diff unit x other,
    "sqlite"     => sqlite_diff unit x other,
    "trino"      => ansi_diff unit x other,
    "hive"       => hive_diff unit x other,
    _            => ansi_diff unit x other,
}

mysql_diff: string -> a -> b -> int = unit => x => other => frag "TIMESTAMPDIFF({:}, {}, {})" [unit_upper unit, x, other]

sqlite_diff: string -> a -> b -> int = unit => x => other => frag "CAST((JULIANDAY({}) - JULIANDAY({})){:} AS INTEGER)" [other, x, julian_scale unit]

ansi_diff: string -> a -> b -> int = unit => x => other => frag "DATE_DIFF({}, {}, {})" [unit, x, other]

pg_diff: string -> a -> b -> int = unit => x => other => case unit {
    "week" => frag "EXTRACT(DAY FROM ({} - {})) / 7" [other, x],
    _      => frag "EXTRACT({:} FROM ({} - {}))" [unit_upper unit, other, x],
}

hive_diff: string -> a -> b -> int = unit => x => other => case unit {
    "day" => frag "DATEDIFF({}, {})" [other, x],
    _     => frag "CAST((UNIX_TIMESTAMP({}) - UNIX_TIMESTAMP({})) / {} AS BIGINT)" [other, x, unit_seconds unit],
}

# The sqlite scale factor: \`* <factor>\` for the units with no calendar-aware
# builtin, nothing for days. JULIANDAY differences are in days.
julian_scale: string -> string = unit => case unit {
    "year"   => " * 0.0027397260273972603",
    "month"  => " * 0.03333333333333333",
    "week"   => " * 0.14285714285714285",
    "hour"   => " * 24",
    "minute" => " * 1440",
    "second" => " * 86400",
    _        => "",
}

# Fixed second-durations for hive, whose DATEDIFF is day-granular: the
# timestamp delta is divided to reach the requested unit.
unit_seconds: string -> int = unit => case unit {
    "year"   => 31536000,
    "month"  => 2592000,
    "week"   => 604800,
    "hour"   => 3600,
    "minute" => 60,
    "second" => 1,
    _        => 86400,
}

# \`dateTrunc x "month"\` — truncate to the start of the unit. The result keeps
# the input's calendar type (a truncated date is still a date).
export dateTrunc: a -> string -> a = x => unit => date_trunc unit x

date_trunc: string -> a -> b = unit => x => case unit {
    "year"   => dialect_trunc "year" x,
    "month"  => dialect_trunc "month" x,
    "week"   => dialect_trunc "week" x,
    "day"    => dialect_trunc "day" x,
    "hour"   => dialect_trunc "hour" x,
    "minute" => dialect_trunc "minute" x,
    "second" => dialect_trunc "second" x,
    _        => fail date_trunc_error,
}

dialect_trunc: string -> a -> b = unit => x => case dialect.name {
    "sqlite" => sqlite_trunc unit x,
    "mysql"  => mysql_trunc unit x,
    "hive"   => hive_trunc unit x,
    _        => ansi_trunc unit x,
}

ansi_trunc: string -> a -> b = unit => x => frag "DATE_TRUNC({}, {})" [unit, x]

sqlite_trunc: string -> a -> b = unit => x => case unit {
    "week" => frag "DATE({}, '-' || ((CAST(STRFTIME('%w', {}) AS INTEGER) + 6) % 7) || ' days')" [x, x],
    _      => frag "STRFTIME({}, {})" [sqlite_trunc_fmt unit, x],
}

mysql_trunc: string -> a -> b = unit => x => case unit {
    "year"   => frag "STR_TO_DATE(DATE_FORMAT({}, '%Y-01-01'), '%Y-%m-%d')" [x],
    "month"  => frag "STR_TO_DATE(DATE_FORMAT({}, '%Y-%m-01'), '%Y-%m-%d')" [x],
    "week"   => frag "DATE_SUB(DATE({}), INTERVAL WEEKDAY({}) DAY)" [x, x],
    "day"    => frag "DATE({})" [x],
    "hour"   => frag "DATE_FORMAT({}, '%Y-%m-%d %H:00:00')" [x],
    "minute" => frag "DATE_FORMAT({}, '%Y-%m-%d %H:%i:00')" [x],
    "second" => frag "DATE_FORMAT({}, '%Y-%m-%d %H:%i:%s')" [x],
    _        => frag "DATE({})" [x],
}

hive_trunc: string -> a -> b = unit => x => case unit {
    "year"  => frag "TRUNC({}, 'YYYY')" [x],
    "month" => frag "TRUNC({}, 'MM')" [x],
    "week"  => frag "TRUNC({}, 'WEEK')" [x],
    "day"   => frag "TRUNC({}, 'DD')" [x],
    _       => frag "FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP({}) / {}) * {})" [x, unit_seconds unit, unit_seconds unit],
}

# The sqlite STRFTIME format that truncates to each unit.
sqlite_trunc_fmt: string -> string = unit => case unit {
    "year"   => "%Y-01-01",
    "month"  => "%Y-%m-01",
    "day"    => "%Y-%m-%d",
    "hour"   => "%Y-%m-%d %H:00:00",
    "minute" => "%Y-%m-%d %H:%M:00",
    "second" => "%Y-%m-%d %H:%M:%S",
    _        => "%Y-%m-%d",
}

# \`dateFormat x fmt\` / \`dateParse x fmt\` — the format string is dialect-native
# and passed through verbatim; only the function differs. sqlite ignores the
# format when parsing, because it accepts most formats natively.
export dateFormat: a -> string -> string = x => fmt => date_format x fmt

date_format: a -> string -> string = x => fmt => case dialect.name {
    "postgresql" => frag "TO_CHAR({}, {})" [x, fmt],
    "sqlite"     => frag "STRFTIME({}, {})" [fmt, x],
    _            => frag "DATE_FORMAT({}, {})" [x, fmt],
}

export dateParse: string -> string -> date = x => fmt => date_parse x fmt

date_parse: string -> string -> date = x => fmt => case dialect.name {
    "postgresql" => frag "TO_TIMESTAMP({}, {})" [x, fmt],
    "mysql"      => frag "STR_TO_DATE({}, {})" [x, fmt],
    "sqlite"     => frag "DATETIME({})" [x],
    "trino"      => frag "DATE_PARSE({}, {})" [x, fmt],
    "hive"       => frag "FROM_UNIXTIME(UNIX_TIMESTAMP({}, {}))" [x, fmt],
    _            => frag "DATE_PARSE({}, {})" [x, fmt],
}

# \`toUnixtime x\` / \`fromUnixtime n\` — unix seconds.
export toUnixtime: a -> int = x => to_unixtime x

to_unixtime: a -> int = x => case dialect.name {
    "postgresql" => frag "EXTRACT(EPOCH FROM {})" [x],
    "sqlite"     => frag "CAST(STRFTIME('%s', {}) AS INTEGER)" [x],
    "mysql"      => frag "UNIX_TIMESTAMP({})" [x],
    "hive"       => frag "UNIX_TIMESTAMP({})" [x],
    _            => frag "TO_UNIXTIME({})" [x],
}

export fromUnixtime: int -> timestamp = n => case dialect.name {
    "postgresql" => frag "TO_TIMESTAMP({})" [n],
    "sqlite"     => frag "DATETIME({}, 'unixepoch')" [n],
    _            => frag "FROM_UNIXTIME({})" [n],
}
`;

/** `base/sql.tetaue` */
export const SQL = `# The SQL surface, in ordinary tetaue.
#
# This module is where the primitive core meets the library. It has two jobs:
#
#   1. PUBLISH the primitive names under their public spellings, so
#      \`table "users"\` / \`filter (u => ...)\` reach a real exported binding of
#      this module rather than a hidden global. Each is an alias for the
#      reserved \`core.*\` namespace — \`core\` is seeded into base modules only,
#      so a user module cannot reach the primitives directly.
#   2. DEFINE the scalar layer on top of the small lowering vocabulary:
#
#        sql_func name [args]      emit FUNC(args)
#        sql_infix op left right   emit \`left op right\`
#        sql_cast value "target"   emit CAST(value AS target)
#        sql_bare word             emit an unquoted SQL word
#        sql_dialect               the dialect record (branch on .name)
#
# Per-dialect variance is a LIBRARY concern: a definition branches on
# \`sql_dialect.name\`, and evaluation constant-folds the branch at analysis
# time (literal \`==\` and \`case\` short-circuit), so exactly one SQL form is
# emitted. The TypeScript core keeps only the query-shape machinery (joins,
# sets, windows, recursive CTEs) that is not a plain scalar call.
#
# The lowering primitives (\`sql_func\`, \`sql_infix\`, \`sql_cast\`, \`sql_bare\`,
# \`sql_dialect\`, \`op_*\`) are deliberately NOT published here: they are the
# library's private vocabulary, and the Prelude does not re-export them.

# ---------------------------------------------------------------------------
# Query roots and steps
# ---------------------------------------------------------------------------

export param = core.param
export table = core.table
export select = core.select
export filter = core.filter
export map = core.map
export fold = core.fold
export sort = core.sort
export take = core.take
export drop = core.drop
export distinct = core.distinct
export recursive = core.recursive

# ---------------------------------------------------------------------------
# Joins
# ---------------------------------------------------------------------------

export joinLateral = core.joinLateral
export joinInner = core.joinInner
export joinLeft = core.joinLeft
export joinRight = core.joinRight
export joinFull = core.joinFull

# ---------------------------------------------------------------------------
# Set operations
# ---------------------------------------------------------------------------

export union = core.union
export unionAll = core.unionAll
export intersect = core.intersect
export except = core.except

# ---------------------------------------------------------------------------
# Ordering
#
# \`asc\`/\`desc\` are TRANSPARENT in the type system: they return the very type
# of their argument (\`asc u.name : string\`). "This is an ORDER BY item" is a
# property of the EXPRESSION, checked at the \`sort\` call site.
# ---------------------------------------------------------------------------

export asc = core.asc
export desc = core.desc

# ---------------------------------------------------------------------------
# Aggregates, grouping, and windows
#
# The aggregate/group/window MODE of each name is declared once in the core
# (\`BUILTIN_MODES\`), derived from the same table the type schemes live in, so
# a \`fold\` entry that is not an aggregate stays a static error.
# ---------------------------------------------------------------------------

export count = core.count
export countDistinct = core.countDistinct
export countWhere = core.countWhere
export sum = core.sum
export sumWhere = core.sumWhere
export avg = core.avg
export avgWhere = core.avgWhere
export min = core.min
export minWhere = core.minWhere
export max = core.max
export maxWhere = core.maxWhere
export array = core.array
export group = core.group

export over = core.over
export rowNumber = core.rowNumber
export rank = core.rank
export denseRank = core.denseRank
export percentRank = core.percentRank
export ntile = core.ntile
export lag = core.lag

# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------

export merge = core.merge
export rename = core.rename
export pick = core.pick
export omit = core.omit

# ---------------------------------------------------------------------------
# Logic and subqueries
# ---------------------------------------------------------------------------

export exists = core.exists
export scalar = core.scalar
export not = core.not
export isIn = core.isIn
export inQuery = core.inQuery
export cast = core.cast
export tryCast = core.tryCast

# ---------------------------------------------------------------------------
# Cast helpers
#
# The primitive spellings name the target type as a STRING LITERAL
# (\`cast u.id "int"\`), which is easy to get wrong: a typo is a static error,
# but the reader still has to remember that the second argument is a type
# NAME rather than a value. These helpers fix the target in the definition,
# so a cast reads as an ordinary one-argument function:
#
#     asInt u.id          asString u.id        asFloat u.balance
#     asBool u.flag       asDate u.pt_dt       asTimestamp u.joined
#
# Each is a \`sql_cast\`/\`sql_try_cast\` wrapper with a precise annotation
# pinning the RESULT type (the primitives leave it open on purpose — see
# their comments in the core). The \`_or_null\` variants are \`tryCast\`: NULL
# instead of an error when the conversion fails.
#
# NOTE: the body is written out per definition rather than shared through an
# \`asImpl = target => x => sql_cast x target\` helper. A helper is
# MONOMORPHIC at its definition site (\`sql_cast\` leaves its result open), so
# every \`x => asImpl "…" x\` annotation would have to match that ONE inferred
# type and all but the first target would be rejected.
# ---------------------------------------------------------------------------

export asInt: a -> int = x => sql_cast x "int"
export asIntOrNull: a -> int = x => sql_try_cast x "int"

export asFloat: a -> float = x => sql_cast x "float"
export asFloatOrNull: a -> float = x => sql_try_cast x "float"

export asDecimal: a -> decimal = x => sql_cast x "decimal"
export asDecimalOrNull: a -> decimal = x => sql_try_cast x "decimal"

export asString: a -> string = x => sql_cast x "string"
export asStringOrNull: a -> string = x => sql_try_cast x "string"

export asBool: a -> bool = x => sql_cast x "bool"
export asBoolOrNull: a -> bool = x => sql_try_cast x "bool"

export asDate: a -> date = x => sql_cast x "date"
export asDateOrNull: a -> date = x => sql_try_cast x "date"

export asTimestamp: a -> timestamp = x => sql_cast x "timestamp"
export asTimestampOrNull: a -> timestamp = x => sql_try_cast x "timestamp"

# ---------------------------------------------------------------------------
# Aliases
#
# Names whose core implementation is still shared keep their aliases here.
# ---------------------------------------------------------------------------

export isNotIn = core.isNotIn
export lead = core.lead
export notInQuery = core.notInQuery

# ---------------------------------------------------------------------------
# Date & time constants
#
# The date/time FUNCTIONS (year, dateAdd, dateTrunc, ...) live in
# \`./sql/time.tetaue\`, where the per-dialect lowering is written as ordinary
# tetaue. What stays here is the part that is not a lowering at all: the
# literal constructors and the niladic current-time constants, which the
# evaluator maps to their own IR nodes (\`date-literal\`, \`current-date\`, ...).
# ---------------------------------------------------------------------------

export date = core.date
export timestamp = core.timestamp
export currentDate = core.currentDate
export currentTimestamp = core.currentTimestamp

# ---------------------------------------------------------------------------
# Strings and many-argument builtins
#
# A HOMOGENEOUS-variadic function takes ONE list argument (\`concat [a, b]\`);
# a function with HETEROGENEOUS arguments is curried position by position
# (\`round x n\`, \`substring x s (just l)\`, \`lpad s n pad\`), because a list
# cannot type \`[string, int, ...]\` soundly. An argument is \`maybe\`-typed only
# when omitting it changes the meaning.
# ---------------------------------------------------------------------------

listFold = list.fold
atLeastTwo = xs => case ((list.length) xs) {
    0 => false,
    1 => false,
    _ => true,
}

# SQLite has no CONCAT and its \`||\` operator propagates NULL. The fold keeps
# the lowering in base while preserving the usual CONCAT behavior: nullable
# arguments become empty strings, and the empty accumulator is harmless for a
# non-empty list (the public function still enforces the two-item minimum at
# runtime).
concatNonNull = xs => case {
    (atLeastTwo xs) => case dialect.name {
        "sqlite" => listFold (acc => x => sql_fragment "{} || {}" [acc, x]) "" xs,
        _        => sql_func "CONCAT" xs,
    },
    _ => sql_error "concat expects at least two expressions",
}
concatNullable = xs => case {
    (atLeastTwo xs) => case dialect.name {
        "sqlite" => listFold (acc => x => sql_fragment "{} || {}" [acc, fromMaybe "" x]) "" xs,
        _        => sql_func "CONCAT" xs,
    },
    _ => sql_error "concat expects at least two expressions",
}

export concat: [string] -> string = xs => concatNonNull xs
export concat: [(maybe string)] -> string = xs => concatNullable xs

export greatest: [a] -> a = xs => case {
    (atLeastTwo xs) => case dialect.name {
        "sqlite" => sql_func "MAX" xs,
        _        => sql_func "GREATEST" xs,
    },
    _ => sql_error "greatest expects at least two expressions",
}
export least: [a] -> a = xs => case {
    (atLeastTwo xs) => case dialect.name {
        "sqlite" => sql_func "MIN" xs,
        _        => sql_func "LEAST" xs,
    },
    _ => sql_error "least expects at least two expressions",
}

export round: int -> int -> int = x => scale => sql_func "ROUND" [x, scale]
export round: float -> int -> float = x => scale => sql_func "ROUND" [x, scale]
export round: decimal -> int -> decimal = x => scale => sql_func "ROUND" [x, scale]

export substring: string -> int -> (maybe int) -> string = s => start => size => case {
    (isNull size) => case dialect.name {
        "sqlite" => sql_func "SUBSTR" [s, start],
        _        => sql_func "SUBSTRING" [s, start],
    },
    _ => case dialect.name {
        "sqlite" => sql_func "SUBSTR" [s, start, size],
        _        => sql_func "SUBSTRING" [s, start, size],
    },
}

pad = left => s => width => fill => case dialect.name {
    "sqlite" => let spaces = replace (sql_func "PRINTF" ["%*s", width, ""]) " " fill in
        let missing = width - length s in
        let truncated = sql_func "SUBSTR" [s, 1, width] in
        let padded = sql_func "SUBSTR" [spaces, 1, missing] in
        case {
            (length s >= width) => truncated,
            left == true => sql_fragment "{} || {}" [padded, s],
            _ => sql_fragment "{} || {}" [s, padded],
        },
    _ => case left {
        true => sql_func "LPAD" [s, width, fill],
        _    => sql_func "RPAD" [s, width, fill],
    },
}

export lpad: string -> int -> string -> string = s => width => fill => pad true s width fill
export rpad: string -> int -> string -> string = s => width => fill => pad false s width fill
export reverse = core.reverse

# ---------------------------------------------------------------------------
# Maybe
# ---------------------------------------------------------------------------

export fromMaybe = core.fromMaybe

# These are ordinary SQL expressions, not evaluator operations. Keeping them
# here makes NULL handling part of the library surface while the core only
# supplies the generic SQL call/fragment vocabulary.
export just = core.just
export nothing = core.nothing

export isNull = core.sql_is_null
export maybeIsJust: (maybe a) -> bool = x => sql_fragment "{} IS NOT NULL" [x]

export isTrue: bool -> bool = x => sql_fragment "{} IS TRUE" [x]
export isTrue: (maybe bool) -> bool = x => sql_fragment "{} IS TRUE" [x]
export isFalse: bool -> bool = x => sql_fragment "{} IS FALSE" [x]
export isFalse: (maybe bool) -> bool = x => sql_fragment "{} IS FALSE" [x]
export isUnknown: bool -> bool = x => sql_fragment "{} IS NULL" [x]
export isUnknown: (maybe bool) -> bool = x => sql_fragment "{} IS NULL" [x]

# \`coalesce\` keeps both useful forms: a binary curried call and a homogeneous
# list call. The list is passed directly to the generic SQL-call primitive.
export coalesce: a -> a -> a = x => y => case {
    (sql_same_type x y) => sql_func "COALESCE" [x, y],
    _ => sql_error "coalesce requires matching types",
}
export coalesce: [(maybe a)] -> (maybe a) = xs => case {
    (atLeastTwo xs) => sql_func "COALESCE" xs,
    _ => sql_error "coalesce expects at least two expressions",
}

export nullIf: a -> a -> a = x => y => sql_func "NULLIF" [x, y]

# ---------------------------------------------------------------------------
# Closed Functor / Applicative / Alternative / Monad operations
#
# The container is chosen at the USE SITE (maybe values, lists, or queries),
# so these stay closed operations rather than type-class methods.
# ---------------------------------------------------------------------------

export fmap = core.fmap
export replaceWith = core.replaceWith
export ap = core.ap
export applyLeft = core.applyLeft
export applyRight = core.applyRight
export orElse = core.orElse
export bind = core.bind
export then = core.then

# ---------------------------------------------------------------------------
# Monoid identity
# ---------------------------------------------------------------------------

export mempty = core.mempty

# ---------------------------------------------------------------------------
# Infix operator meanings
#
# The public \`_+_\`/\`_*_\`/... bindings in the Prelude alias these.
# ---------------------------------------------------------------------------

export sql_multiply = core.op_multiply
export sql_divide = core.op_divide
export sql_add = core.op_add
export sql_subtract = core.op_subtract
export sql_merge = core.op_merge
export sql_equal = core.op_equal
export sql_not_equal = core.op_not_equal
export sql_less_than = core.op_less_than
export sql_less_than_or_equal = core.op_less_than_or_equal
export sql_greater_than = core.op_greater_than
export sql_greater_than_or_equal = core.op_greater_than_or_equal
export sql_and = core.op_and
export sql_or = core.op_or

# ---------------------------------------------------------------------------
# Scalar layer
#
# Private vocabulary the definitions below are written in. These are base
# module LOCALS (unexported), so they never leave this module.
#
# (They are bound to the ambient primitives rather than to \`core.*\` because
# they are used positionally inside lambdas; both spellings refer to the same
# value.)
# ---------------------------------------------------------------------------

lowering_func = sql_func
lowering_infix = sql_infix
dialect = sql_dialect

# --- no per-dialect variance ---
#
# The precise annotation keeps each type exact (\`length\` is int, not a fresh
# variable); \`sql_func\` itself leaves the result type open on purpose.

export toUpper: string -> string = x => lowering_func "UPPER" [x]
export toLower: string -> string = x => lowering_func "LOWER" [x]
export length: string -> int = x => lowering_func "LENGTH" [x]
export trim: string -> string = x => lowering_func "TRIM" [x]
export replace: string -> string -> string -> string = s => f => r => lowering_func "REPLACE" [s, f, r]

# \`mod\` renders MOD(a, b) in every dialect; \`like\` is a binary operator.
export mod: int -> int -> int = a => b => lowering_func "MOD" [a, b]
export like: string -> string -> bool = x => p => lowering_infix "LIKE" x p

# --- per-dialect variance ---

export div: int -> int -> int = a => b => case dialect.name {
    "mysql" => lowering_infix "DIV" a b,
    "hive"  => lowering_infix "DIV" a b,
    _       => lowering_infix "/" a b,
}

export leftSubstring: string -> int -> string = s => n => case dialect.name {
    "sqlite" => lowering_func "SUBSTR" [s, 1, n],
    _        => lowering_func "LEFT" [s, n],
}

export rightSubstring: string -> int -> string = s => n => case dialect.name {
    "sqlite" => lowering_func "SUBSTR" [s, (-n)],
    _        => lowering_func "RIGHT" [s, n],
}

# \`ceil\` is spelled differently on sqlite. The shared body keeps that branch
# in ONE place instead of repeating it per overload. It is private
# (unexported), so it never becomes part of this module's public surface.
ceil_impl = x => case dialect.name {
    "sqlite" => lowering_func "CEILING" [x],
    _        => lowering_func "CEIL" [x],
}

# Numeric math unaries are OVERLOADED, one definition per numeric type —
# this is what replaces the compiler-owned Num class: the argument's type
# selects the definition (\`abs u.age\` takes the int one, \`abs u.balance\` the
# float one), and a non-numeric argument matches no definition at all.
export abs: int -> int = x => lowering_func "ABS" [x]
export abs: float -> float = x => lowering_func "ABS" [x]
export abs: decimal -> decimal = x => lowering_func "ABS" [x]

export ceil: int -> int = x => ceil_impl x
export ceil: float -> float = x => ceil_impl x
export ceil: decimal -> decimal = x => ceil_impl x

export floor: int -> int = x => lowering_func "FLOOR" [x]
export floor: float -> float = x => lowering_func "FLOOR" [x]
export floor: decimal -> decimal = x => lowering_func "FLOOR" [x]

export sqrt: float -> float = x => lowering_func "SQRT" [x]
export sqrt: decimal -> decimal = x => lowering_func "SQRT" [x]

export pow: int -> int -> int = x => y => lowering_func "POW" [x, y]
export pow: float -> float -> float = x => y => lowering_func "POW" [x, y]
export pow: decimal -> decimal -> decimal = x => y => lowering_func "POW" [x, y]

# \`position\` varies per dialect in BOTH the function name and the argument
# order, so its lowering branches on the dialect record. The argument-
# reordered form (POSITION(needle IN value)) is expressed with the infix
# primitive.
export position: string -> string -> int = x => n => case dialect.name {
    "postgresql" => lowering_func "POSITION" [lowering_infix "IN" n x],
    "trino"      => lowering_func "POSITION" [lowering_infix "IN" n x],
    "mysql"      => lowering_func "LOCATE" [n, x],
    _            => lowering_func "INSTR" [x, n],
}
`;

/** Every base module: canonical import path -> its source text. */
export const BASE_MODULE_SOURCES: Readonly<Record<string, string>> = {
    "data/function.tetaue": DATA_FUNCTION,
    "base/data/function.tetaue": DATA_FUNCTION,
    "base/data/function": DATA_FUNCTION,
    "data/maybe.tetaue": DATA_MAYBE,
    "base/data/maybe.tetaue": DATA_MAYBE,
    "base/data/maybe": DATA_MAYBE,
    "prelude.tetaue": PRELUDE,
    "base/prelude.tetaue": PRELUDE,
    "base/prelude": PRELUDE,
    "sql/time.tetaue": SQL_TIME,
    "base/sql/time.tetaue": SQL_TIME,
    "base/sql/time": SQL_TIME,
    "sql.tetaue": SQL,
    "base/sql.tetaue": SQL,
    "base/sql": SQL,
};
