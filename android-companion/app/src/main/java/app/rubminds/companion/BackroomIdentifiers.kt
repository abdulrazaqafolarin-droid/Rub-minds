package app.rubminds.companion

/** Canonical UUID validation for Backroom IDs crossing the Android device boundary. */
internal val UUID_PATTERN: Regex = Regex(
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    RegexOption.IGNORE_CASE
)
