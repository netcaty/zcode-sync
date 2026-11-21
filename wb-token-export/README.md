# wb-token-export

wb-token-export reads the encrypted sign-in data of WorkBuddy desktop. The tool writes a JSON file. The magpie workbuddy plugin imports this file.

## Warning

Protect the JSON file. The file contains access tokens and refresh tokens. Do not send the file to other persons.

After the import, sign in again on WorkBuddy desktop. magpie renews the token during the import. This action signs out the desktop client.

## Requirements

- Windows 10 or Windows 11.
- WorkBuddy desktop with an active sign-in.
- Node.js 18 or later. If Node.js is not present, the tool uses the Electron runtime of WorkBuddy.

## Run the tool

Open a terminal in this directory. Run this command:

```bat
wb-token-export.cmd
```

The tool writes `workbuddy-signin-<timestamp>.json` in the current directory.

To write a different file, run:

```bat
wb-token-export.cmd -o my-signin.json
```

## Options

| Option | Function |
| --- | --- |
| `-o`, `--out FILE` | Write the JSON to FILE. Use `-` for standard output. |
| `--file PATH` | Read the sign-in file at PATH. |
| `--exe PATH` | Use the WorkBuddy executable at PATH. |
| `--verify` | Check the account list after export. The tool does not change tokens. |
| `--allow-stale` | Export the data even if the access token is expired. |
| `--json` | Write a summary to standard error as JSON. |
| `-h`, `--help` | Show the help text. |
| `-V`, `--version` | Show the version. |

## Import the JSON file

1. Open magpie.
2. Select Accounts.
3. Select Add WorkBuddy.
4. Select Import accounts from a file.
5. Select the JSON file that the tool wrote.

magpie renews the token with WorkBuddy before it imports the account.
