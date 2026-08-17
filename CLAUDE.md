# OpenPDFStudio - Development Guidelines

**READ THIS FILE BEFORE MAKING ANY CHANGES.**

---

## Cursor Rules

- **DO NOT** change cursor. it shall be default cursor. except for the area that the pdf file is shown.

---

## Modals / Dialogs

- Use **Windows-style** appearance (squared corners, no border-radius)
- Title bar: gradient `#ffffff` to `#f5f5f5`, border `#d4d4d4`
- Close button: turns red (`#e81123`) on hover
- **No move cursor** on draggable headers

## Running the App

- When running `tauri dev` or any long-running process, always run it in the background and do NOT wait/block for it to finish.

## General

- Match Windows Forms / Visual Studio aesthetic
- Avoid rounded corners except where specified
- Keep UI compact and functional
- No unnecessary animations or effects
- When creating a modal window, the window shall be movable and do not disappear when user click on somewhere outside of it. just like a default behaviour of modal form.
- Do not run app when some changes are implimented when app is running and hot reload is true.

## Git workflow and releases
- Use generic product terminology in source comments and commit messages. Do not use proprietary third-party product names as comparisons or shorthand.
- Create a proposed commit message by comparing the current files with the committed changes.
- Do not include Claude or Anthropic references in commit messages.
- Show the proposed commit message to the user and obtain explicit approval before committing.
- Normal feature-branch commits and pushes do not change the application version.
- Version bumps, installer workflows, and draft releases are release operations. Run them only when the user explicitly requests a release candidate, release branch, version tag, or final release task.
