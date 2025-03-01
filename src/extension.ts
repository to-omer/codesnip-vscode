import * as cp from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';

function execShell(cmd: string, outputChannel: vscode.OutputChannel): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		outputChannel.appendLine(`$ ${cmd}`);
		cp.exec(cmd, (err, stdout, stderr) => {
			if (stderr) { outputChannel.append(stderr); }
			if (err) {
				outputChannel.appendLine(err.message);
				return reject(err);
			}
			return resolve(stdout);
		});
	});
}

class CodesnipContext {
	context: vscode.ExtensionContext;
	outputChannel: vscode.OutputChannel;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.outputChannel = vscode.window.createOutputChannel("Codesnip");
	}

	execShell(cmd: string): Promise<string> {
		return execShell(cmd, this.outputChannel);
	}

	async targetDirectory(): Promise<string> {
		try {
			let cmd = 'cargo metadata --format-version=1';
			const folders = vscode.workspace.workspaceFolders;
			if (folders !== undefined && folders.length >= 1) {
				const manifestPath = vscode.Uri.joinPath(folders[0].uri, 'Cargo.toml').fsPath;
				cmd += ` --manifest-path ${manifestPath}`;
			}
			const value = await this.execShell(cmd);
			const metadata = JSON.parse(value);
			return metadata.target_directory;
		} catch (err) {
			vscode.window.showErrorMessage("Codesnip: " + err);
			return "target";
		}
	}

	async findConfigFile(fileName: string): Promise<string | null> {
		if (fs.existsSync(fileName)) { return fileName; }
		const folders = vscode.workspace.workspaceFolders;
		if (folders === undefined) { return null; }
		for (const folder of folders) {
			const configPath = vscode.Uri.joinPath(folder.uri, fileName).fsPath;
			if (fs.existsSync(configPath)) {
				this.outputChannel.appendLine(`Found config file: ${configPath}`);
				return configPath;
			}
		}
		return null;
	}

	async getConfig(): Promise<CodesnipConfiguration> {
		const targetDir = await this.targetDirectory();
		const codesnip = vscode.workspace.getConfiguration('codesnip');
		let cacheFile = targetDir + '/codesnip/codesnip-cache.bin';
		let sourceConfig = await this.findConfigFile(codesnip.get<string>('sourceConfig', 'codesnip.json'));
		let insertionPosition = InsertionPosition.fromString(codesnip.get<string>('insertionPosition', 'last'));
		let autoUpdate = codesnip.get<boolean>('autoUpdate', false);
		let autoVerify = codesnip.get<boolean>('autoVerify', false);
		let notHide = codesnip.get<boolean>('notHide', false);
		let toolchain = codesnip.get<string | null>('verify.toolchain', null);
		let edition = codesnip.get<string | null>('verify.edition', null);
		let verbose = codesnip.get<boolean>('verify.verbose', false);
		const config = { cacheFile, sourceConfig, insertionPosition, autoUpdate, autoVerify, notHide, toolchain, edition, verbose };
		return config;
	}
}

class Codesnip {
	context: vscode.ExtensionContext;
	outputChannel: vscode.OutputChannel;
	config: CodesnipConfiguration;

	constructor(context: CodesnipContext, config: CodesnipConfiguration) {
		this.context = context.context;
		this.outputChannel = context.outputChannel;
		this.config = config;
	}

	execShell(cmd: string): Promise<string> {
		return execShell(cmd, this.outputChannel);
	}

	updateCache() {
		if (this.config.sourceConfig === null || !fs.existsSync(this.config.sourceConfig)) {
			vscode.window.showErrorMessage("Codesnip: sourceConfig not found: " + this.config.sourceConfig);
			return;
		}
		const cmd = `cargo codesnip --source-config="${this.config.sourceConfig}" cache "${this.config.cacheFile}"`;
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Codesnip update cache"
		}, progress => this.execShell(cmd).then(() => {
			progress.report({ increment: 100 });
			if (this.config.autoVerify) {
				this.verifySnippet();
			}
		}).catch(err => { vscode.window.showErrorMessage("Codesnip: " + err); }));
	}

	checkCache(force: boolean = false): boolean {
		if (force && this.config.autoUpdate) {
			this.updateCache();
			return fs.existsSync(this.config.cacheFile);
		}
		if (fs.existsSync(this.config.cacheFile)) {
			return true;
		}
		if (force) {
			this.updateCache();
			return fs.existsSync(this.config.cacheFile);
		}
		const updateItem = "Update Cache";
		vscode.window.showInformationMessage("Codesnip: cache not found", updateItem).then(selection => {
			if (selection === updateItem) {
				vscode.commands.executeCommand("codesnip-vscode.updateCache");
			}
		});
		return false;
	}

	addUpdateCache() {
		const updateCacheDisposable = vscode.commands.registerCommand('codesnip-vscode.updateCache', () => this.updateCache());
		this.context.subscriptions.push(updateCacheDisposable);
	}

	verifySnippet() {
		if (!this.checkCache()) { return; }

		const codesnipcmd = `cargo codesnip --use-cache=${this.config.cacheFile}`;
		let verifycmd = codesnipcmd + ' verify';
		if (this.config.toolchain !== null) { verifycmd += ` --toolchain=${this.config.toolchain}`; }
		if (this.config.edition !== null) { verifycmd += ` --edition=${this.config.edition}`; }
		if (this.config.verbose) { verifycmd += ' --verbose'; }
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Codesnip verify snippets"
		}, progress => this.execShell(verifycmd).then(() => {
			progress.report({ increment: 1 });
			const showOutputItem = "Show Output";
			vscode.window.showInformationMessage("Codesnip: Verify snippets success", showOutputItem).then(selection => {
				if (selection === showOutputItem) {
					this.outputChannel.show();
				}
			});
		}).catch(err => {
			const showOutputItem = "Show Output";
			vscode.window.showErrorMessage("Codesnip: " + err, showOutputItem).then(selection => {
				if (selection === showOutputItem) {
					this.outputChannel.show();
				}
			});
		}));
	}

	addVerifySnippet() {
		const verifySnippetsDisposable = vscode.commands.registerCommand('codesnip-vscode.verifySnippets', () => this.verifySnippet());
		this.context.subscriptions.push(verifySnippetsDisposable);
	}

	addBundleSnippet() {
		const bundleDisposable = vscode.commands.registerCommand('codesnip-vscode.bundle', () => {
			if (!this.checkCache()) { return; }

			const codesnipcmd = `cargo codesnip --use-cache=${this.config.cacheFile}`;
			let listcmd = codesnipcmd + ' list';
			if (this.config.notHide) {
				listcmd += ' --not-hide';
			}
			this.execShell(listcmd).then(value => value.trimEnd().split(" ")).then(items => {
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
					this.execShell(cmd).then(value => {
						editor?.edit(builder => {
							if (this.config.insertionPosition === InsertionPosition.cursor) {
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
			}).catch(err => { vscode.window.showErrorMessage("Codesnip: " + err); });
		});
		this.context.subscriptions.push(bundleDisposable);
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const codesnipContext = new CodesnipContext(context);

	try { await codesnipContext.execShell('cargo --version'); } catch {
		vscode.window.showErrorMessage("Codesnip: `cargo` not found");
		return;
	};
	try {
		const value = await codesnipContext.execShell('cargo codesnip --version');
		const version = value.trim().split(' ')[1];
		const versionArray = version.split('.').map(Number);
		if (versionArray < [0, 4, 0]) {
			vscode.window.showErrorMessage(`Codesnip: Minimum version 0.4.0, found ${value}\nRun \`cargo install codesnip\` and restart VSCode.`);
			return;
		}
	} catch {
		vscode.window.showErrorMessage("Codesnip: `cargo-codesnip` not found.\nRun `cargo install codesnip` and restart VSCode.");
		return;
	};
	const config = await codesnipContext.getConfig();
	const codesnip = new Codesnip(codesnipContext, config);

	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('codesnip')) {
			codesnipContext.getConfig().then(config => {
				codesnip.config = config;
			});
		}
	});

	codesnip.checkCache(true);
	codesnip.addUpdateCache();
	codesnip.addVerifySnippet();
	codesnip.addBundleSnippet();
}

export function deactivate() { }

interface CodesnipConfiguration {
	cacheFile: string,
	sourceConfig: string | null,
	insertionPosition: InsertionPosition,
	autoUpdate: boolean,
	autoVerify: boolean,
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
