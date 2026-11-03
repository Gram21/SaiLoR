# Translations

This page tells you how the user interface text works and how to add a language.

## How it works

- The English texts are in `src/locales/en.json`. English is the reference language.
- Each other language has one file with the same keys, for example `src/locales/de.json`.
- A key is a stable id such as `settings.title`. It is not the English text.
- Components get the text with `useT()` and `t('key', { name: value })`.
- Non-React code imports `t` from `src/i18n.ts` and calls it when it creates the message.
- `{name}` in a text is a placeholder. SaiLoR replaces it with a value.
- Texts that change with a number use two keys, `key_one` and `key_other`. Call `tp('key', count)`.
- `rich('key')` renders `<strong>`, `<em>`, `<code>`, `<kbd>`, `<b>` and `<i>` in a text.
- Dates and numbers use `Intl` with the active language from `getLanguage()`.
- The native menus get their German texts from the `DE` table in `src-tauri/src/shell.rs`.

## What stays in English

Do not translate these items:

- schema field names and project data
- AI prompts and other text that SaiLoR sends to a model
- requirement ids, log output and file formats
- raw messages from git and from the Rust shell

## Add a text

1. Add the key and the English text to `src/locales/en.json`.
2. Add the same key with the translated text to each other language file.
3. Use the key in the code with `t`, `tp` or `rich`.
4. Run `npx vitest run src/i18n.test.ts`.

## Add a language

1. Copy `src/locales/en.json` to a new file, for example `src/locales/fr.json`.
2. Translate each value in the new file. Do not change the keys.
3. Keep each placeholder such as `{count}` and each tag such as `<strong>` unchanged.
4. Add the language code to `LANGUAGES` in `src/state/settings.ts`.
5. Import the file and add it to `MESSAGES` in `src/i18n.ts`.
6. Add the name of the language in that language to `LANGUAGE_NAMES` in `src/i18n.ts`.
7. If the language needs native menus, add a table like `DE` in `src-tauri/src/shell.rs`.
8. Then change `tr` and `app_set_language` in `src-tauri/src/shell.rs` to use the new table.
9. Run `npx tsc -b --noEmit`, `npx vitest run` and `make test-rust`.

## Checks

- The type check fails if a language file does not have all English keys.
- `src/i18n.test.ts` fails if a language file has an extra key or an empty text.
- `src/i18n.test.ts` also fails if the placeholders or tags of a key are different.
- `every_menu_label_has_a_german_entry` in `src-tauri/src/shell.rs` checks the German menu table.

Caution: English is the fallback. A missing translation shows the English text and no error.
