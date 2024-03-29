import * as cp from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
	try { await execShell('cargo --version'); } catch {
		vscode.window.showErrorMessage("Codesnip: `cargo` not found");
		return;
	};
	try { await execShell('cargo codesnip --version'); } catch {
		vscode.window.showErrorMessage("Codesnip: `cargo-codesnip` not found.\nRun `cargo install codesnip`.");
		return;
	};

	const config = getCodesnipConfiguration();
	if (config === undefined) {
		vscode.window.showErrorMessage("Codesnip: No cache file is set");
		vscode.commands.executeCommand('workbench.action.openSettings', 'codesnip');
		return;
	}
	if (config.source.length === 0) {
		const openItem = "Open Settings";
		vscode.window.showErrorMessage("Codesnip: No source file is set", openItem).then(selection => {
			if (selection === openItem) {
				vscode.commands.executeCommand('workbench.action.openSettings', 'codesnip');
			}
		});
	}

	const updateCacheDisposable = vscode.commands.registerCommand('codesnip-vscode.updateCache', () => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Codesnip update cache"
		}, progress => execShell(getUpdateCacheCommand(config)).then(() => {
			progress.report({ increment: 1 });
			activate(context);
		}).catch(err => { vscode.window.showErrorMessage("Codesnip: " + err); }));
	});
	context.subscriptions.push(updateCacheDisposable);

	try {
		fs.statSync(config.cacheFile);
		const codesnipcmd = `cargo codesnip --use-cache=${config.cacheFile}`;

		const verifySnippetsDisposable = vscode.commands.registerCommand('codesnip-vscode.verifySnippets', () => {
			const terminal = vscode.window.createTerminal('Codesnip');
			terminal.show(false);
			let verifycmd = codesnipcmd + ' verify';
			if (config.toolchain !== null) { verifycmd += ` --toolchain=${config.toolchain}`; }
			if (config.edition !== null) { verifycmd += ` --edition=${config.edition}`; }
			if (config.verbose) { verifycmd += ' --verbose'; }
			terminal.sendText(verifycmd);
		});
		context.subscriptions.push(verifySnippetsDisposable);

		let listcmd = codesnipcmd + ' list';
		if (config.notHide) {
			listcmd += ' --not-hide';
		}
		execShell(listcmd).then(value => value.trimEnd().split(" ")).then(items => {
			const bundleDisposable = vscode.commands.registerCommand('codesnip-vscode.bundle', () => {
				vscode.window.showQuickPick(items, { placeHolder: "name" }).then(bundle => {
					if (bundle === undefined) { return; }
					let cmd = codesnipcmd + ` bundle "${bundle}"`;
					const editor = vscode.window.activeTextEditor;
					const document = editor?.document;
					const text = document?.getText();
					if (text !== undefined) {
						const regex = /^\/\/ codesnip-guard: (\w+)$/gm;
						let arr;
						while ((arr = regex.exec(text)) !== null) { cmd += ` -e="${arr[1]}"`; }
					}
					execShell(cmd).then(value => {
						editor?.edit(builder => {
							if (config.insertionPosition === InsertionPosition.cursor) {
								builder.replace(editor?.selection, value.trimEnd() + '\n');
							} else {
								const end = document?.lineAt(document?.lineCount - 1).range.end;
								if (end !== undefined) { builder.insert(end, value.trimEnd() + '\n'); }
							}
						});
					}).catch(err => {
						vscode.window.showErrorMessage("Codesnip: " + err);
					});
				});
			});
			context.subscriptions.push(bundleDisposable);
		}).catch(err => { vscode.window.showErrorMessage("Codesnip: " + err); });
	} catch (err) {
		const updateItem = "Update Cache";
		vscode.window.showInformationMessage("Codesnip: cache not found", updateItem).then(selection => {
			if (selection === updateItem) {
				vscode.commands.executeCommand("codesnip-vscode.updateCache");
			}
		});
	}

	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('codesnip')) {
			activate(context);
		}
	});
}

export function deactivate() { }

interface CodesnipConfiguration {
	cacheFile: string,
	source: string[],
	cfg: string[],
	filterItem: string[],
	filterAttr: string[],
	minify: boolean,
	insertionPosition: InsertionPosition,
	notHide: boolean,
	toolchain: string | null,
	edition: string | null,
	verbose: boolean,
}

enum InsertionPosition {
	last,
	cursor
}

namespace InsertionPosition {
	export function fromString(str: string | undefined): InsertionPosition {
		switch (str) {
			case "cursor": return InsertionPosition.cursor;
			default: return InsertionPosition.last;
		}
	}
}

function getCodesnipConfiguration(): CodesnipConfiguration | undefined {
	const codesnip = vscode.workspace.getConfiguration('codesnip');
	let cacheFile = codesnip.get<string | null>('cacheFile', null);
	if (cacheFile === null) { cacheFile = getDefaultCacheFile(); }
	if (cacheFile === null) { return undefined; }
	let source = codesnip.get<string[]>('source', []);
	let cfg = codesnip.get<string[]>('cfg', []);
	let filterItem = codesnip.get<string[]>('filterItem', []);
	let filterAttr = codesnip.get<string[]>('filterAttr', []);
	let minify = codesnip.get<boolean>('minify', false);
	let insertionPosition = InsertionPosition.fromString(codesnip.get<string>('insertionPosition'));
	let notHide = codesnip.get<boolean>('notHide', false);
	let toolchain = codesnip.get<string | null>('verify.toolchain', null);
	let edition = codesnip.get<string | null>('verify.edition', null);
	let verbose = codesnip.get<boolean>('verify.verbose', false);
	return { cacheFile, source, cfg, filterItem, filterAttr, minify, insertionPosition, notHide, toolchain, edition, verbose };
}

function getDefaultCacheFile(): string | null {
	const folders = vscode.workspace.workspaceFolders;
	if (folders !== undefined && folders.length >= 1) {
		return vscode.Uri.joinPath(folders[0].uri, 'target/codesnip/codesnip-cache.bin').fsPath;
	} else {
		return null;
	}
}

function getUpdateCacheCommand(config: CodesnipConfiguration): string {
	let cmd = `cargo codesnip`;
	config.source.forEach(value => { cmd += ` -t=${value}`; });
	config.cfg.forEach(value => { cmd += ` --cfg=${value}`; });
	config.filterItem.forEach(value => { cmd += ` --filter-item=${value}`; });
	config.filterAttr.forEach(value => { cmd += ` --filter-attr=${value}`; });
	if (config.minify) { cmd += " --format=minify"; }
	cmd += ` cache "${config.cacheFile}"`;
	return cmd;
}

function execShell(cmd: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		cp.exec(cmd, (err, out) => {
			if (err) { return reject(err); }
			return resolve(out);
		});
	});
}
