/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Severity } from 'vs/platform/notification/common/notification';
import * as nls from 'vs/nls';
import * as path from 'vs/base/common/path';
import * as semver from 'vs/base/common/semver/semver';
import * as json from 'vs/base/common/json';
import * as arrays from 'vs/base/common/arrays';
import { getParseErrorMessage } from 'vs/base/common/jsonErrorMessages';
import * as types from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { getGalleryExtensionId, getExtensionId, ExtensionKey } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { isValidExtensionVersion } from 'vs/platform/extensions/common/extensionValidator';
import { ExtensionIdentifier, IExtensionDescription, IRelaxedExtensionDescription, TargetPlatform, UNDEFINED_PUBLISHER } from 'vs/platform/extensions/common/extensions';
import { Metadata } from 'vs/platform/extensionManagement/common/extensionManagement';

const MANIFEST_FILE = 'package.json';

export interface Translations {
	[id: string]: string;
}

export namespace Translations {
	export function equals(a: Translations, b: Translations): boolean {
		if (a === b) {
			return true;
		}
		let aKeys = Object.keys(a);
		let bKeys: Set<string> = new Set<string>();
		for (let key of Object.keys(b)) {
			bKeys.add(key);
		}
		if (aKeys.length !== bKeys.size) {
			return false;
		}

		for (let key of aKeys) {
			if (a[key] !== b[key]) {
				return false;
			}
			bKeys.delete(key);
		}
		return bKeys.size === 0;
	}
}

export interface ILog {
	error(source: string, message: string): void;
	warn(source: string, message: string): void;
	info(source: string, message: string): void;
}

export class Logger implements ILog {

	private readonly _messageHandler: (severity: Severity, source: string, message: string) => void;

	constructor(
		messageHandler: (severity: Severity, source: string, message: string) => void
	) {
		this._messageHandler = messageHandler;
	}

	public error(source: string, message: string): void {
		this._messageHandler(Severity.Error, source, message);
	}

	public warn(source: string, message: string): void {
		this._messageHandler(Severity.Warning, source, message);
	}

	public info(source: string, message: string): void {
		this._messageHandler(Severity.Info, source, message);
	}
}

export interface NlsConfiguration {
	readonly devMode: boolean;
	readonly locale: string | undefined;
	readonly pseudo: boolean;
	readonly translations: Translations;
}

abstract class ExtensionManifestHandler {

	protected readonly _ourVersion: string;
	protected readonly _ourProductDate: string | undefined;
	protected readonly _host: IExtensionScannerHost;
	protected readonly _absoluteFolderPath: string;
	protected readonly _isBuiltin: boolean;
	protected readonly _isUnderDevelopment: boolean;
	protected readonly _absoluteManifestPath: string;

	constructor(ourVersion: string, ourProductDate: string | undefined, host: IExtensionScannerHost, absoluteFolderPath: string, isBuiltin: boolean, isUnderDevelopment: boolean) {
		this._ourVersion = ourVersion;
		this._ourProductDate = ourProductDate;
		this._host = host;
		this._absoluteFolderPath = absoluteFolderPath;
		this._isBuiltin = isBuiltin;
		this._isUnderDevelopment = isUnderDevelopment;
		this._absoluteManifestPath = path.join(absoluteFolderPath, MANIFEST_FILE);
	}

	protected _error(source: string, message: string): void {
		this._host.log.error(source, message);
	}

	protected _warn(source: string, message: string): void {
		this._host.log.warn(source, message);
	}

	protected _info(source: string, message: string): void {
		this._host.log.info(source, message);
	}
}

class ExtensionManifestParser extends ExtensionManifestHandler {

	private static _fastParseJSON<T>(text: string, errors: json.ParseError[]): T {
		try {
			return JSON.parse(text);
		} catch (err) {
			// invalid JSON, let's get good errors
			return json.parse(text, errors);
		}
	}

	public parse(): Promise<IExtensionDescription | null> {
		return this._host.readFile(this._absoluteManifestPath).then((manifestContents) => {
			const errors: json.ParseError[] = [];
			const manifest = ExtensionManifestParser._fastParseJSON<IRelaxedExtensionDescription & { __metadata?: Metadata }>(manifestContents, errors);
			if (json.getNodeType(manifest) !== 'object') {
				this._error(this._absoluteFolderPath, nls.localize('jsonParseInvalidType', "Invalid manifest file {0}: Not an JSON object.", this._absoluteManifestPath));
			} else if (errors.length === 0) {
				manifest.uuid = manifest.__metadata?.id;
				manifest.targetPlatform = manifest.__metadata?.targetPlatform ?? TargetPlatform.UNDEFINED;
				manifest.isUserBuiltin = !!manifest.__metadata?.isBuiltin;
				delete manifest.__metadata;
				return manifest;
			} else {
				errors.forEach(e => {
					this._error(this._absoluteFolderPath, nls.localize('jsonParseFail', "Failed to parse {0}: [{1}, {2}] {3}.", this._absoluteManifestPath, e.offset, e.length, getParseErrorMessage(e.error)));
				});
			}
			return null;
		}, (err) => {
			if (err.code === 'ENOENT') {
				return null;
			}

			this._error(this._absoluteFolderPath, nls.localize('fileReadFail', "Cannot read file {0}: {1}.", this._absoluteManifestPath, err.message));
			return null;
		});
	}
}

interface MessageBag {
	[key: string]: string | { message: string; comment: string[] };
}

interface TranslationBundle {
	contents: {
		package: MessageBag;
	};
}

interface LocalizedMessages {
	values: MessageBag | undefined;
	default: string | null;
}

class ExtensionManifestNLSReplacer extends ExtensionManifestHandler {

	private readonly _nlsConfig: NlsConfiguration;

	constructor(ourVersion: string, ourProductDate: string | undefined, host: IExtensionScannerHost, absoluteFolderPath: string, isBuiltin: boolean, isUnderDevelopment: boolean, nlsConfig: NlsConfiguration) {
		super(ourVersion, ourProductDate, host, absoluteFolderPath, isBuiltin, isUnderDevelopment);
		this._nlsConfig = nlsConfig;
	}

	public replaceNLS(extensionDescription: IExtensionDescription): Promise<IExtensionDescription> {
		const reportErrors = (localized: string | null, errors: json.ParseError[]): void => {
			errors.forEach((error) => {
				this._error(this._absoluteFolderPath, nls.localize('jsonsParseReportErrors', "Failed to parse {0}: {1}.", localized, getParseErrorMessage(error.error)));
			});
		};
		const reportInvalidFormat = (localized: string | null): void => {
			this._error(this._absoluteFolderPath, nls.localize('jsonInvalidFormat', "Invalid format {0}: JSON object expected.", localized));
		};

		let extension = path.extname(this._absoluteManifestPath);
		let basename = this._absoluteManifestPath.substr(0, this._absoluteManifestPath.length - extension.length);

		const translationId = `${extensionDescription.publisher}.${extensionDescription.name}`;
		let translationPath = this._nlsConfig.translations[translationId];
		let localizedMessages: Promise<LocalizedMessages | undefined>;
		if (translationPath) {
			localizedMessages = this._host.readFile(translationPath).then<LocalizedMessages, LocalizedMessages>((content) => {
				let errors: json.ParseError[] = [];
				let translationBundle: TranslationBundle = json.parse(content, errors);
				if (errors.length > 0) {
					reportErrors(translationPath, errors);
					return { values: undefined, default: `${basename}.nls.json` };
				} else if (json.getNodeType(translationBundle) !== 'object') {
					reportInvalidFormat(translationPath);
					return { values: undefined, default: `${basename}.nls.json` };
				} else {
					let values = translationBundle.contents ? translationBundle.contents.package : undefined;
					return { values: values, default: `${basename}.nls.json` };
				}
			}, (error) => {
				return { values: undefined, default: `${basename}.nls.json` };
			});
		} else {
			localizedMessages = this._host.existsFile(basename + '.nls' + extension).then<LocalizedMessages | undefined, LocalizedMessages | undefined>(exists => {
				if (!exists) {
					return undefined;
				}
				return ExtensionManifestNLSReplacer.findMessageBundles(this._host, this._nlsConfig, basename).then((messageBundle) => {
					if (!messageBundle.localized) {
						return { values: undefined, default: messageBundle.original };
					}
					return this._host.readFile(messageBundle.localized).then(messageBundleContent => {
						let errors: json.ParseError[] = [];
						let messages: MessageBag = json.parse(messageBundleContent, errors);
						if (errors.length > 0) {
							reportErrors(messageBundle.localized, errors);
							return { values: undefined, default: messageBundle.original };
						} else if (json.getNodeType(messages) !== 'object') {
							reportInvalidFormat(messageBundle.localized);
							return { values: undefined, default: messageBundle.original };
						}
						return { values: messages, default: messageBundle.original };
					}, (err) => {
						return { values: undefined, default: messageBundle.original };
					});
				}, (err) => {
					return undefined;
				});
			});
		}

		return localizedMessages.then((localizedMessages) => {
			if (localizedMessages === undefined) {
				return extensionDescription;
			}
			let errors: json.ParseError[] = [];
			// resolveOriginalMessageBundle returns null if localizedMessages.default === undefined;
			return this.resolveOriginalMessageBundle(localizedMessages.default, errors).then((defaults) => {
				if (errors.length > 0) {
					reportErrors(localizedMessages.default, errors);
					return extensionDescription;
				} else if (json.getNodeType(localizedMessages) !== 'object') {
					reportInvalidFormat(localizedMessages.default);
					return extensionDescription;
				}
				const localized = localizedMessages.values || Object.create(null);
				ExtensionManifestNLSReplacer._replaceNLStrings(this._nlsConfig, extensionDescription, localized, defaults, this._host.log, this._absoluteFolderPath);
				return extensionDescription;
			});
		}, (err) => {
			return extensionDescription;
		});
	}

	/**
	 * Parses original message bundle, returns null if the original message bundle is null.
	 */
	private resolveOriginalMessageBundle(originalMessageBundle: string | null, errors: json.ParseError[]) {
		return new Promise<{ [key: string]: string } | null>((c, e) => {
			if (originalMessageBundle) {
				this._host.readFile(originalMessageBundle).then(originalBundleContent => {
					c(json.parse(originalBundleContent, errors));
				}, (err) => {
					c(null);
				});
			} else {
				c(null);
			}
		});
	}

	/**
	 * Finds localized message bundle and the original (unlocalized) one.
	 * If the localized file is not present, returns null for the original and marks original as localized.
	 */
	private static findMessageBundles(host: IExtensionScannerHost, nlsConfig: NlsConfiguration, basename: string): Promise<{ localized: string; original: string | null }> {
		return new Promise<{ localized: string; original: string | null }>((c, e) => {
			function loop(basename: string, locale: string): void {
				let toCheck = `${basename}.nls.${locale}.json`;
				host.existsFile(toCheck).then(exists => {
					if (exists) {
						c({ localized: toCheck, original: `${basename}.nls.json` });
					}
					let index = locale.lastIndexOf('-');
					if (index === -1) {
						c({ localized: `${basename}.nls.json`, original: null });
					} else {
						locale = locale.substring(0, index);
						loop(basename, locale);
					}
				});
			}

			if (nlsConfig.devMode || nlsConfig.pseudo || !nlsConfig.locale) {
				return c({ localized: basename + '.nls.json', original: null });
			}
			loop(basename, nlsConfig.locale);
		});
	}

	/**
	 * This routine makes the following assumptions:
	 * The root element is an object literal
	 */
	private static _replaceNLStrings<T extends object>(nlsConfig: NlsConfiguration, literal: T, messages: MessageBag, originalMessages: MessageBag | null, log: ILog, messageScope: string): void {
		function processEntry(obj: any, key: string | number, command?: boolean) {
			const value = obj[key];
			if (types.isString(value)) {
				const str = <string>value;
				const length = str.length;
				if (length > 1 && str[0] === '%' && str[length - 1] === '%') {
					const messageKey = str.substr(1, length - 2);
					let translated = messages[messageKey];
					// If the messages come from a language pack they might miss some keys
					// Fill them from the original messages.
					if (translated === undefined && originalMessages) {
						translated = originalMessages[messageKey];
					}
					let message: string | undefined = typeof translated === 'string' ? translated : (typeof translated?.message === 'string' ? translated.message : undefined);
					if (message !== undefined) {
						if (nlsConfig.pseudo) {
							// FF3B and FF3D is the Unicode zenkaku representation for [ and ]
							message = '\uFF3B' + message.replace(/[aouei]/g, '$&$&') + '\uFF3D';
						}
						obj[key] = command && (key === 'title' || key === 'category') && originalMessages ? { value: message, original: originalMessages[messageKey] } : message;
					} else {
						log.warn(messageScope, nls.localize('missingNLSKey', "Couldn't find message for key {0}.", messageKey));
					}
				}
			} else if (types.isObject(value)) {
				for (let k in value) {
					if (value.hasOwnProperty(k)) {
						k === 'commands' ? processEntry(value, k, true) : processEntry(value, k, command);
					}
				}
			} else if (types.isArray(value)) {
				for (let i = 0; i < value.length; i++) {
					processEntry(value, i, command);
				}
			}
		}

		for (let key in literal) {
			if (literal.hasOwnProperty(key)) {
				processEntry(literal, key);
			}
		}
	}
}

class ExtensionManifestValidator extends ExtensionManifestHandler {
	validate(_extensionDescription: IExtensionDescription): IExtensionDescription | null {
		let extensionDescription = <IRelaxedExtensionDescription>_extensionDescription;
		extensionDescription.isBuiltin = this._isBuiltin;
		extensionDescription.isUserBuiltin = !this._isBuiltin && !!extensionDescription.isUserBuiltin;
		extensionDescription.isUnderDevelopment = this._isUnderDevelopment;

		let notices: string[] = [];
		if (!ExtensionManifestValidator.isValidExtensionDescription(this._ourVersion, this._ourProductDate, this._absoluteFolderPath, extensionDescription, notices)) {
			notices.forEach((error) => {
				this._error(this._absoluteFolderPath, error);
			});
			return null;
		}

		// in this case the notices are warnings
		notices.forEach((error) => {
			this._warn(this._absoluteFolderPath, error);
		});

		// allow publisher to be undefined to make the initial extension authoring experience smoother
		if (!extensionDescription.publisher) {
			extensionDescription.publisher = UNDEFINED_PUBLISHER;
		}

		// id := `publisher.name`
		extensionDescription.id = getExtensionId(extensionDescription.publisher, extensionDescription.name);
		extensionDescription.identifier = new ExtensionIdentifier(extensionDescription.id);

		extensionDescription.extensionLocation = URI.file(this._absoluteFolderPath);

		return extensionDescription;
	}

	private static isValidExtensionDescription(version: string, productDate: string | undefined, extensionFolderPath: string, extensionDescription: IExtensionDescription, notices: string[]): boolean {

		if (!ExtensionManifestValidator.baseIsValidExtensionDescription(extensionFolderPath, extensionDescription, notices)) {
			return false;
		}

		if (!semver.valid(extensionDescription.version)) {
			notices.push(nls.localize('notSemver', "Extension version is not semver compatible."));
			return false;
		}

		return isValidExtensionVersion(version, productDate, extensionDescription, notices);
	}

	private static baseIsValidExtensionDescription(extensionFolderPath: string, extensionDescription: IExtensionDescription, notices: string[]): boolean {
		if (!extensionDescription) {
			notices.push(nls.localize('extensionDescription.empty', "Got empty extension description"));
			return false;
		}
		if (typeof extensionDescription.publisher !== 'undefined' && typeof extensionDescription.publisher !== 'string') {
			notices.push(nls.localize('extensionDescription.publisher', "property publisher must be of type `string`."));
			return false;
		}
		if (typeof extensionDescription.name !== 'string') {
			notices.push(nls.localize('extensionDescription.name', "property `{0}` is mandatory and must be of type `string`", 'name'));
			return false;
		}
		if (typeof extensionDescription.version !== 'string') {
			notices.push(nls.localize('extensionDescription.version', "property `{0}` is mandatory and must be of type `string`", 'version'));
			return false;
		}
		if (!extensionDescription.engines) {
			notices.push(nls.localize('extensionDescription.engines', "property `{0}` is mandatory and must be of type `object`", 'engines'));
			return false;
		}
		if (typeof extensionDescription.engines.vscode !== 'string') {
			notices.push(nls.localize('extensionDescription.engines.vscode', "property `{0}` is mandatory and must be of type `string`", 'engines.vscode'));
			return false;
		}
		if (typeof extensionDescription.extensionDependencies !== 'undefined') {
			if (!ExtensionManifestValidator._isStringArray(extensionDescription.extensionDependencies)) {
				notices.push(nls.localize('extensionDescription.extensionDependencies', "property `{0}` can be omitted or must be of type `string[]`", 'extensionDependencies'));
				return false;
			}
		}
		if (typeof extensionDescription.activationEvents !== 'undefined') {
			if (!ExtensionManifestValidator._isStringArray(extensionDescription.activationEvents)) {
				notices.push(nls.localize('extensionDescription.activationEvents1', "property `{0}` can be omitted or must be of type `string[]`", 'activationEvents'));
				return false;
			}
			if (typeof extensionDescription.main === 'undefined' && typeof extensionDescription.browser === 'undefined') {
				notices.push(nls.localize('extensionDescription.activationEvents2', "properties `{0}` and `{1}` must both be specified or must both be omitted", 'activationEvents', 'main'));
				return false;
			}
		}
		if (typeof extensionDescription.extensionKind !== 'undefined') {
			if (typeof extensionDescription.main === 'undefined') {
				notices.push(nls.localize('extensionDescription.extensionKind', "property `{0}` can be defined only if property `main` is also defined.", 'extensionKind'));
				// not a failure case
			}
		}
		if (typeof extensionDescription.main !== 'undefined') {
			if (typeof extensionDescription.main !== 'string') {
				notices.push(nls.localize('extensionDescription.main1', "property `{0}` can be omitted or must be of type `string`", 'main'));
				return false;
			} else {
				const normalizedAbsolutePath = path.join(extensionFolderPath, extensionDescription.main);
				if (!normalizedAbsolutePath.startsWith(extensionFolderPath)) {
					notices.push(nls.localize('extensionDescription.main2', "Expected `main` ({0}) to be included inside extension's folder ({1}). This might make the extension non-portable.", normalizedAbsolutePath, extensionFolderPath));
					// not a failure case
				}
			}
			if (typeof extensionDescription.activationEvents === 'undefined') {
				notices.push(nls.localize('extensionDescription.main3', "properties `{0}` and `{1}` must both be specified or must both be omitted", 'activationEvents', 'main'));
				return false;
			}
		}
		if (typeof extensionDescription.browser !== 'undefined') {
			if (typeof extensionDescription.browser !== 'string') {
				notices.push(nls.localize('extensionDescription.browser1', "property `{0}` can be omitted or must be of type `string`", 'browser'));
				return false;
			} else {
				const normalizedAbsolutePath = path.join(extensionFolderPath, extensionDescription.browser);
				if (!normalizedAbsolutePath.startsWith(extensionFolderPath)) {
					notices.push(nls.localize('extensionDescription.browser2', "Expected `browser` ({0}) to be included inside extension's folder ({1}). This might make the extension non-portable.", normalizedAbsolutePath, extensionFolderPath));
					// not a failure case
				}
			}
			if (typeof extensionDescription.activationEvents === 'undefined') {
				notices.push(nls.localize('extensionDescription.browser3', "properties `{0}` and `{1}` must both be specified or must both be omitted", 'activationEvents', 'browser'));
				return false;
			}
		}
		return true;
	}

	private static _isStringArray(arr: string[]): boolean {
		if (!Array.isArray(arr)) {
			return false;
		}
		for (let i = 0, len = arr.length; i < len; i++) {
			if (typeof arr[i] !== 'string') {
				return false;
			}
		}
		return true;
	}
}

export class ExtensionScannerInput {

	public mtime: number | undefined;

	constructor(
		public readonly ourVersion: string,
		public readonly ourProductDate: string | undefined,
		public readonly commit: string | undefined,
		public readonly locale: string | undefined,
		public readonly devMode: boolean,
		public readonly absoluteFolderPath: string,
		public readonly isBuiltin: boolean,
		public readonly isUnderDevelopment: boolean,
		public readonly targetPlatform: TargetPlatform,
		public readonly translations: Translations
	) {
		// Keep empty!! (JSON.parse)
	}

	public static createNLSConfig(input: ExtensionScannerInput): NlsConfiguration {
		return {
			devMode: input.devMode,
			locale: input.locale,
			pseudo: input.locale === 'pseudo',
			translations: input.translations
		};
	}

	public static equals(a: ExtensionScannerInput, b: ExtensionScannerInput): boolean {
		return (
			a.ourVersion === b.ourVersion
			&& a.ourProductDate === b.ourProductDate
			&& a.commit === b.commit
			&& a.locale === b.locale
			&& a.devMode === b.devMode
			&& a.absoluteFolderPath === b.absoluteFolderPath
			&& a.isBuiltin === b.isBuiltin
			&& a.isUnderDevelopment === b.isUnderDevelopment
			&& a.mtime === b.mtime
			&& Translations.equals(a.translations, b.translations)
		);
	}
}

export interface IExtensionReference {
	name: string;
	path: string;
}

export interface IExtensionResolver {
	resolveExtensions(): Promise<IExtensionReference[]>;
}

class DefaultExtensionResolver implements IExtensionResolver {

	constructor(
		private readonly _host: IExtensionScannerHost,
		private readonly root: string
	) { }

	resolveExtensions(): Promise<IExtensionReference[]> {
		return this._host.readDirsInDir(this.root)
			.then(folders => folders.map(name => ({ name, path: path.join(this.root, name) })));
	}
}

export interface IExtensionScannerHost {
	readonly log: ILog;
	/**
	 * If a file is not found, it must throw an error with a field `error.code` equal to 'ENOENT'
	 */
	readFile(filename: string): Promise<string>;
	existsFile(filename: string): Promise<boolean>;
	readDirsInDir(dirPath: string): Promise<string[]>;
}

export class ExtensionScanner {

	/**
	 * Read the extension defined in `absoluteFolderPath`
	 */
	private static scanExtension(version: string, productDate: string | undefined, host: IExtensionScannerHost, absoluteFolderPath: string, isBuiltin: boolean, isUnderDevelopment: boolean, nlsConfig: NlsConfiguration): Promise<IExtensionDescription | null> {
		absoluteFolderPath = path.normalize(absoluteFolderPath);

		let parser = new ExtensionManifestParser(version, productDate, host, absoluteFolderPath, isBuiltin, isUnderDevelopment);
		return parser.parse().then<IExtensionDescription | null>((extensionDescription) => {
			if (extensionDescription === null) {
				return null;
			}

			let nlsReplacer = new ExtensionManifestNLSReplacer(version, productDate, host, absoluteFolderPath, isBuiltin, isUnderDevelopment, nlsConfig);
			return nlsReplacer.replaceNLS(extensionDescription);
		}).then((extensionDescription) => {
			if (extensionDescription === null) {
				return null;
			}

			let validator = new ExtensionManifestValidator(version, productDate, host, absoluteFolderPath, isBuiltin, isUnderDevelopment);
			return validator.validate(extensionDescription);
		});
	}

	/**
	 * Scan a list of extensions defined in `absoluteFolderPath`
	 */
	public static async scanExtensions(input: ExtensionScannerInput, host: IExtensionScannerHost, resolver: IExtensionResolver | null = null): Promise<IExtensionDescription[]> {
		const absoluteFolderPath = input.absoluteFolderPath;
		const isBuiltin = input.isBuiltin;
		const isUnderDevelopment = input.isUnderDevelopment;

		if (!resolver) {
			resolver = new DefaultExtensionResolver(host, absoluteFolderPath);
		}

		try {
			let obsolete: { [folderName: string]: boolean } = {};
			if (!isBuiltin) {
				try {
					const obsoleteFileContents = await host.readFile(path.join(absoluteFolderPath, '.obsolete'));
					obsolete = JSON.parse(obsoleteFileContents);
				} catch (err) {
					// Don't care
				}
			}

			let refs = await resolver.resolveExtensions();

			// Ensure the same extension order
			refs.sort((a, b) => a.name < b.name ? -1 : 1);

			if (!isBuiltin) {
				refs = refs.filter(ref => ref.name.indexOf('.') !== 0); // Do not consider user extension folder starting with `.`
			}

			const nlsConfig = ExtensionScannerInput.createNLSConfig(input);
			let _extensionDescriptions = await Promise.all(refs.map(r => this.scanExtension(input.ourVersion, input.ourProductDate, host, r.path, isBuiltin, isUnderDevelopment, nlsConfig)));
			let extensionDescriptions = arrays.coalesce(_extensionDescriptions);
			extensionDescriptions = extensionDescriptions.filter(item => item !== null && !obsolete[new ExtensionKey({ id: getGalleryExtensionId(item.publisher, item.name) }, item.version, item.targetPlatform).toString()]);

			if (!isBuiltin) {
				extensionDescriptions = this.filterOutdatedExtensions(extensionDescriptions, input.targetPlatform);
			}

			extensionDescriptions.sort((a, b) => {
				if (a.extensionLocation.fsPath < b.extensionLocation.fsPath) {
					return -1;
				}
				return 1;
			});
			return extensionDescriptions;
		} catch (err) {
			host.log.error(absoluteFolderPath, err);
			return [];
		}
	}

	/**
	 * Combination of scanExtension and scanExtensions: If an extension manifest is found at root, we load just this extension,
	 * otherwise we assume the folder contains multiple extensions.
	 */
	public static scanOneOrMultipleExtensions(input: ExtensionScannerInput, host: IExtensionScannerHost): Promise<IExtensionDescription[]> {
		const absoluteFolderPath = input.absoluteFolderPath;
		const isBuiltin = input.isBuiltin;
		const isUnderDevelopment = input.isUnderDevelopment;

		return host.existsFile(path.join(absoluteFolderPath, MANIFEST_FILE)).then((exists) => {
			if (exists) {
				const nlsConfig = ExtensionScannerInput.createNLSConfig(input);
				return this.scanExtension(input.ourVersion, input.ourProductDate, host, absoluteFolderPath, isBuiltin, isUnderDevelopment, nlsConfig).then((extensionDescription) => {
					if (extensionDescription === null) {
						return [];
					}
					return [extensionDescription];
				});
			}
			return this.scanExtensions(input, host);
		}, (err) => {
			host.log.error(absoluteFolderPath, err);
			return [];
		});
	}

	public static scanSingleExtension(input: ExtensionScannerInput, host: IExtensionScannerHost): Promise<IExtensionDescription | null> {
		const absoluteFolderPath = input.absoluteFolderPath;
		const isBuiltin = input.isBuiltin;
		const isUnderDevelopment = input.isUnderDevelopment;
		const nlsConfig = ExtensionScannerInput.createNLSConfig(input);
		return this.scanExtension(input.ourVersion, input.ourProductDate, host, absoluteFolderPath, isBuiltin, isUnderDevelopment, nlsConfig);
	}

	public static mergeBuiltinExtensions(builtinExtensions: Promise<IExtensionDescription[]>, extraBuiltinExtensions: Promise<IExtensionDescription[]>): Promise<IExtensionDescription[]> {
		return Promise.all([builtinExtensions, extraBuiltinExtensions]).then(([builtinExtensions, extraBuiltinExtensions]) => {
			let resultMap: { [id: string]: IExtensionDescription } = Object.create(null);
			for (let i = 0, len = builtinExtensions.length; i < len; i++) {
				resultMap[ExtensionIdentifier.toKey(builtinExtensions[i].identifier)] = builtinExtensions[i];
			}
			// Overwrite with extensions found in extra
			for (let i = 0, len = extraBuiltinExtensions.length; i < len; i++) {
				resultMap[ExtensionIdentifier.toKey(extraBuiltinExtensions[i].identifier)] = extraBuiltinExtensions[i];
			}

			let resultArr = Object.keys(resultMap).map((id) => resultMap[id]);
			resultArr.sort((a, b) => {
				const aLastSegment = path.basename(a.extensionLocation.fsPath);
				const bLastSegment = path.basename(b.extensionLocation.fsPath);
				if (aLastSegment < bLastSegment) {
					return -1;
				}
				if (aLastSegment > bLastSegment) {
					return 1;
				}
				return 0;
			});
			return resultArr;
		});
	}

	private static filterOutdatedExtensions(extensions: IExtensionDescription[], targetPlatform: TargetPlatform): IExtensionDescription[] {
		const result = new Map<string, IExtensionDescription>();
		for (const extension of extensions) {
			const extensionKey = extension.identifier.value;
			const existing = result.get(extensionKey);
			if (existing) {
				if (semver.gt(existing.version, extension.version)) {
					continue;
				}
				if (semver.eq(existing.version, extension.version) && existing.targetPlatform === targetPlatform) {
					continue;
				}
			}
			result.set(extensionKey, extension);
		}
		return [...result.values()];
	}
}
