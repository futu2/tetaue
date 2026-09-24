/******************************************************************************
 * GENERATED — do not edit. Run `bun run base:generate` instead.
 * The files under `base/` are the source of truth.
 ******************************************************************************/
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
