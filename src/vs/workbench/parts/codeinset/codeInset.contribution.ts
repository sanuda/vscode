/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// import { Registry } from 'vs/platform/registry/common/platform';
// import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from 'vs/workbench/common/contributions';
// import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { CancelablePromise, createCancelablePromise, RunOnceScheduler } from 'vs/base/common/async';
import { onUnexpectedError } from 'vs/base/common/errors';
import { dispose, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { StableEditorScrollState } from 'vs/editor/browser/core/editorState';
import * as editorBrowser from 'vs/editor/browser/editorBrowser';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { IModelDecorationsChangeAccessor } from 'vs/editor/common/model';
import { CodeInsetProviderRegistry } from 'vs/editor/common/modes';
import { CodeInsetWidget, CodeInsetHelper } from './codeInsetWidget';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { getCodeInsetData, ICodeInsetData } from './codeinset';
import { registerEditorContribution } from 'vs/editor/browser/editorExtensions';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { MainThreadWebviews } from 'vs/workbench/api/electron-browser/mainThreadWebview';

export class CodeInsetController implements editorCommon.IEditorContribution {

	private static readonly ID: string = 'css.editor.codeInset';

	private _isEnabled: boolean;

	private _globalToDispose: IDisposable[];
	private _localToDispose: IDisposable[];
	private _insetWidgets: CodeInsetWidget[];
	private _currentFindCodeInsetSymbolsPromise: CancelablePromise<ICodeInsetData[]>;
	private _modelChangeCounter: number;
	private _currentResolveCodeInsetSymbolsPromise: CancelablePromise<any>;
	private _detectVisibleInsets: RunOnceScheduler;
	private _mainThreadWebviews: MainThreadWebviews;

	constructor(
		private _editor: editorBrowser.ICodeEditor,
		@ICommandService private readonly _commandService: ICommandService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IExtensionService private readonly _extensionService: IExtensionService
	) {
		this._isEnabled = this._editor.getConfiguration().contribInfo.codeInsets;

		this._globalToDispose = [];
		this._localToDispose = [];
		this._insetWidgets = [];
		this._currentFindCodeInsetSymbolsPromise = null;
		this._modelChangeCounter = 0;

		this._globalToDispose.push(this._editor.onDidChangeModel(() => this._onModelChange()));
		this._globalToDispose.push(this._editor.onDidChangeModelLanguage(() => this._onModelChange()));
		this._globalToDispose.push(this._editor.onDidChangeConfiguration(() => {
			let prevIsEnabled = this._isEnabled;
			this._isEnabled = this._editor.getConfiguration().contribInfo.codeInsets;
			if (prevIsEnabled !== this._isEnabled) {
				this._onModelChange();
			}
		}));
		this._globalToDispose.push(CodeInsetProviderRegistry.onDidChange(this._onModelChange, this));
		this._onModelChange();
	}

	dispose(): void {
		this._localDispose();
		this._globalToDispose = dispose(this._globalToDispose);
	}

	private _localDispose(): void {
		if (this._currentFindCodeInsetSymbolsPromise) {
			this._currentFindCodeInsetSymbolsPromise.cancel();
			this._currentFindCodeInsetSymbolsPromise = null;
			this._modelChangeCounter++;
		}
		if (this._currentResolveCodeInsetSymbolsPromise) {
			this._currentResolveCodeInsetSymbolsPromise.cancel();
			this._currentResolveCodeInsetSymbolsPromise = null;
		}
		this._localToDispose = dispose(this._localToDispose);
	}

	getId(): string {
		return CodeInsetController.ID;
	}

	private _onModelChange(): void {
		this._localDispose();

		const model = this._editor.getModel();
		if (!model || !this._isEnabled || !CodeInsetProviderRegistry.has(model)) {
			return;
		}

		for (const provider of CodeInsetProviderRegistry.all(model)) {
			if (typeof provider.onDidChange === 'function') {
				let registration = provider.onDidChange(() => scheduler.schedule());
				this._localToDispose.push(registration);
			}
		}

		this._detectVisibleInsets = new RunOnceScheduler(() => {
			this._onViewportChanged();
		}, 500);

		const scheduler = new RunOnceScheduler(() => {
			const counterValue = ++this._modelChangeCounter;
			if (this._currentFindCodeInsetSymbolsPromise) {
				this._currentFindCodeInsetSymbolsPromise.cancel();
			}

			this._currentFindCodeInsetSymbolsPromise = createCancelablePromise(token => getCodeInsetData(model, token));

			this._currentFindCodeInsetSymbolsPromise.then(codeInsetData => {
				if (counterValue === this._modelChangeCounter) { // only the last one wins
					this._renderCodeInsetSymbols(codeInsetData);
					this._detectVisibleInsets.schedule();
				}
			}, onUnexpectedError);
		}, 250);

		this._localToDispose.push(scheduler);

		this._localToDispose.push(this._detectVisibleInsets);

		this._localToDispose.push(this._editor.onDidChangeModelContent(() => {
			this._editor.changeDecorations(changeAccessor => {
				this._editor.changeViewZones(viewAccessor => {
					let toDispose: CodeInsetWidget[] = [];
					let lastInsetLineNumber: number = -1;
					this._insetWidgets.forEach(inset => {
						if (!inset.isValid() || lastInsetLineNumber === inset.getLineNumber()) {
							// invalid -> Inset collapsed, attach range doesn't exist anymore
							// line_number -> insets should never be on the same line
							toDispose.push(inset);
						}
						else {
							inset.reposition(viewAccessor);
							lastInsetLineNumber = inset.getLineNumber();
						}
					});
					let helper = new CodeInsetHelper();
					toDispose.forEach((l) => {
						l.dispose(helper, viewAccessor);
						this._insetWidgets.splice(this._insetWidgets.indexOf(l), 1);
					});
					helper.commit(changeAccessor);
				});
			});
			// Compute new `visible` code insets
			this._detectVisibleInsets.schedule();
			// Ask for all references again
			scheduler.schedule();
		}));

		this._localToDispose.push(this._editor.onDidScrollChange(e => {
			if (e.scrollTopChanged && this._insetWidgets.length > 0) {
				this._detectVisibleInsets.schedule();
			}
		}));

		this._localToDispose.push(this._editor.onDidLayoutChange(() => {
			this._detectVisibleInsets.schedule();
		}));

		this._localToDispose.push(toDisposable(() => {
			if (this._editor.getModel()) {
				const scrollState = StableEditorScrollState.capture(this._editor);
				this._editor.changeDecorations((changeAccessor) => {
					this._editor.changeViewZones((accessor) => {
						this._disposeAllInsets(changeAccessor, accessor);
					});
				});
				scrollState.restore(this._editor);
			} else {
				// No accessors available
				this._disposeAllInsets(null, null);
			}
		}));

		scheduler.schedule();
	}

	private _disposeAllInsets(decChangeAccessor: IModelDecorationsChangeAccessor, viewZoneChangeAccessor: editorBrowser.IViewZoneChangeAccessor): void {
		let helper = new CodeInsetHelper();
		this._insetWidgets.forEach((Inset) => Inset.dispose(helper, viewZoneChangeAccessor));
		if (decChangeAccessor) {
			helper.commit(decChangeAccessor);
		}
		this._insetWidgets = [];
	}

	private _renderCodeInsetSymbols(symbols: ICodeInsetData[]): void {
		if (!this._editor.getModel()) {
			return;
		}

		let maxLineNumber = this._editor.getModel().getLineCount();
		let groups: ICodeInsetData[][] = [];
		let lastGroup: ICodeInsetData[];

		for (let symbol of symbols) {
			let line = symbol.symbol.range.startLineNumber;
			if (line < 1 || line > maxLineNumber) {
				// invalid code Inset
				continue;
			} else if (lastGroup && lastGroup[lastGroup.length - 1].symbol.range.startLineNumber === line) {
				// on same line as previous
				lastGroup.push(symbol);
			} else {
				// on later line as previous
				lastGroup = [symbol];
				groups.push(lastGroup);
			}
		}

		const scrollState = StableEditorScrollState.capture(this._editor);

		this._editor.changeDecorations(changeAccessor => {
			this._editor.changeViewZones(accessor => {

				let codeInsetIndex = 0, groupsIndex = 0, helper = new CodeInsetHelper();

				while (groupsIndex < groups.length && codeInsetIndex < this._insetWidgets.length) {

					let symbolsLineNumber = groups[groupsIndex][0].symbol.range.startLineNumber;
					let codeInsetLineNumber = this._insetWidgets[codeInsetIndex].getLineNumber();

					if (codeInsetLineNumber < symbolsLineNumber) {
						this._insetWidgets[codeInsetIndex].dispose(helper, accessor);
						this._insetWidgets.splice(codeInsetIndex, 1);
					} else if (codeInsetLineNumber === symbolsLineNumber) {
						this._insetWidgets[codeInsetIndex].updateCodeInsetSymbols(groups[groupsIndex], helper);
						groupsIndex++;
						codeInsetIndex++;
					} else {
						this._insetWidgets.splice(codeInsetIndex, 0,
							new CodeInsetWidget(groups[groupsIndex],
								this._editor, helper,
								this._commandService, this._notificationService,
								() => this._detectVisibleInsets.schedule()));
						codeInsetIndex++;
						groupsIndex++;
					}
				}

				// Delete extra code insets
				while (codeInsetIndex < this._insetWidgets.length) {
					this._insetWidgets[codeInsetIndex].dispose(helper, accessor);
					this._insetWidgets.splice(codeInsetIndex, 1);
				}

				// Create extra symbols
				while (groupsIndex < groups.length) {
					this._insetWidgets.push(
						new CodeInsetWidget(groups[groupsIndex],
							this._editor, helper,
							this._commandService, this._notificationService,
							() => this._detectVisibleInsets.schedule()));
					groupsIndex++;
				}

				helper.commit(changeAccessor);
			});
		});

		scrollState.restore(this._editor);
	}


	private getWebviewService(): MainThreadWebviews {
		if (!this._mainThreadWebviews) {
			this._mainThreadWebviews = this._extensionService.getNamedCustomer('MainThreadWebviews');
		}
		return this._mainThreadWebviews;
	}


	private _onViewportChanged(): void {
		if (this._currentResolveCodeInsetSymbolsPromise) {
			this._currentResolveCodeInsetSymbolsPromise.cancel();
			this._currentResolveCodeInsetSymbolsPromise = null;
		}

		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const allWidgetRequests: ICodeInsetData[][] = [];
		const insetWidgets: CodeInsetWidget[] = [];
		this._insetWidgets.forEach(inset => {
			const widgetRequests = inset.computeIfNecessary(model);
			if (widgetRequests) {
				allWidgetRequests.push(widgetRequests);
				insetWidgets.push(inset);
			}
		});

		if (allWidgetRequests.length === 0) {
			return;
		}

		this._currentResolveCodeInsetSymbolsPromise = createCancelablePromise(token => {

			const allPromises = allWidgetRequests.map((widgetRequests, r) => {

				const widgetPromises = widgetRequests.map(request => {
					const symbol = request.symbol;
					if (typeof request.provider.resolveCodeInset === 'function') {
						const mainThreadWebviews = this.getWebviewService();
						symbol.webviewHandle = insetWidgets[r].createWebview(mainThreadWebviews, request.provider.extensionLocation);
						return request.provider.resolveCodeInset(model, symbol, token);
					}
					return Promise.resolve(void 0);
				});

				return Promise.all(widgetPromises);
			});

			return Promise.all(allPromises);
		});

		this._currentResolveCodeInsetSymbolsPromise.then(() => {
			this._currentResolveCodeInsetSymbolsPromise = null;
		}).catch(err => {
			this._currentResolveCodeInsetSymbolsPromise = null;
			onUnexpectedError(err);
		});
	}
}

registerEditorContribution(CodeInsetController);
