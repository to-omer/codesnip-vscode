import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	const cache = getCacheFile();
	if (cache === undefined) {
		vscode.window.showErrorMessage("Codesnip: No cache file is set");
		return;
	}
	try { fs.statSync(path.dirname(cache)); } catch (err) {
		fs.mkdir(path.dirname(cache), { recursive: true }, err => { vscode.window.showErrorMessage("Codesnip: " + err); });
	}
	try { fs.statSync(cache); } catch (err) {
		try {
			const fd = fs.openSync(cache, 'w');
			fs.writeSync(fd, "{}");
			fs.closeSync(fd);
		} catch (err) {
			vscode.window.showErrorMessage("Codesnip: " + err);
		}
		vscode.window.showInformationMessage("Codesnip: cache not found", "Update Cache").then(() => {
			vscode.commands.executeCommand("codesnip-vscode.updateCache");
		});
	}

	const codesnipcmd = `cargo codesnip --use-cache=${cache}`;
	execShell(codesnipcmd + ' list').then(value => value.trimEnd().split(/\r\n|\n/)).then(items => {
		const bundleDisposable = vscode.commands.registerCommand('codesnip-vscode.bundle', () => {
			let options: vscode.QuickPickOptions = { placeHolder: "name" };
			vscode.window.showQuickPick(items, options).then(bundle => {
				if (bundle) {
					let cmd = codesnipcmd + ` bundle ${bundle}`;
					const editor = vscode.window.activeTextEditor;
					const text = editor?.document.getText();
					if (text) {
						const regex = /^\/\/ codesnip-guard: (\w+)$/gm;
						let arr;
						while ((arr = regex.exec(text)) !== null) { cmd += ` -e=${arr[1]}`; }
					}
					execShell(cmd).then(value => {
						editor?.edit((builder) => {
							const pos: string | undefined = vscode.workspace.getConfiguration().get('codesnip.insertionPosition');
							if (pos === "cursor") {
								builder.replace(editor.selection, value.trimEnd() + '\n');
							} else {
								const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
								builder.insert(end, value.trimEnd() + '\n');
							}
						});
					}).catch(err => {
						vscode.window.showErrorMessage("Codesnip: " + err);
					});
				}
			});
		});
		context.subscriptions.push(bundleDisposable);
	}).catch(err => { vscode.window.showErrorMessage("Codesnip: " + err); });

	const updateCacheDisposable = vscode.commands.registerCommand('codesnip-vscode.updateCache', () => {
		let cmd = `cargo codesnip`;
		const targets: string[] | undefined = vscode.workspace.getConfiguration().get('codesnip.source');
		targets?.forEach((value) => { cmd += ` -t=${value}`; });
		const cfgs: string[] | undefined = vscode.workspace.getConfiguration().get('codesnip.cfg');
		cfgs?.forEach((value) => { cmd += ` --cfg=${value}`; });
		const fis: string[] | undefined = vscode.workspace.getConfiguration().get('codesnip.filterItem');
		fis?.forEach((value) => { cmd += ` --filter-item=${value}`; });
		const fas: string[] | undefined = vscode.workspace.getConfiguration().get('codesnip.filterAttr');
		fas?.forEach((value) => { cmd += ` --filter-attr=${value}`; });
		cmd += ` cache ${cache}`;
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Codesnip update cache"
		}, (progress) => execShell(cmd).then(() => {
			progress.report({ increment: 1 });
			vscode.window.showInformationMessage("Codesnip: reload required", "Reload Now").then(() => {
				vscode.commands.executeCommand("workbench.action.reloadWindow");
			});
		}).catch(err => { vscode.window.showErrorMessage("Codesnip: " + err); }));
	});
	context.subscriptions.push(updateCacheDisposable);
}

export function deactivate() { }

function getCacheFile() {
	const cache: string | null | undefined = vscode.workspace.getConfiguration().get('codesnip.cacheFile');
	if (cache !== null && cache !== undefined) {
		return cache;
	} else {
		const folders = vscode.workspace.workspaceFolders;
		if (folders !== undefined && folders.length >= 1) {
			return vscode.Uri.joinPath(folders[0].uri, 'target/codesnip/codesnip-cache.json').fsPath;
		}
	}
}

function execShell(cmd: string) {
	return new Promise<string>((resolve, reject) => {
		cp.exec(cmd, (err, out) => {
			if (err) {
				return reject(err);
			}
			return resolve(out);
		});
	});
}
