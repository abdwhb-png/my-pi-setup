# Auto Translate

Auto Translate starts disabled in every session. It keeps its commands available at startup, but loads its widget only when translation is enabled and its translation engine only for the first eligible input. Disabling translation hides the widget and passes input through. Already imported modules remain available for later use in the same extension instance.

## Commands

| Command | Behavior |
| --- | --- |
| `/translate-on` | Enable translation to the current target and load the status widget. |
| `/translate-off` | Disable translation and hide the widget. |
| `/translate-to-<code>` | Select a configured target language and enable translation. |
| `/translate-send` | Toggle between sending translated text and displaying the translation while sending the original text. It does not enable translation by itself. |

Send mode is enabled by default. Blank input and extension-injected messages are never translated. Configuring a language or toggling send mode while disabled does not load the translation engine. A fresh session resets translation to off.

## Configuration

Settings are read from `~/.pi/agent/config/translate.json`, with overrides from `.pi/config/translate.json` only when saved project trust permits them. Configuration still loads at startup so language commands are immediately available. For example:

```json
{
  "defaultTargetLanguage": "en",
  "languages": {
    "en": "English",
    "fr": "French"
  }
}
```

The optional `model` field selects a `provider/model-id` from the session model registry. Without it, translation uses the active session model. Translation uses a direct provider completion with the session's existing authentication. It does not launch another agent.

The first eligible input loads the translation module and its provider client. Later inputs reuse loaded modules. Missing model/authentication or an unchanged translation passes the original input through. Provider or module-loading exceptions remain visible through Pi's extension error handling, and the transient translating status is cleared even on failure.
