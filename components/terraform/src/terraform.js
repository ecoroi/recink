'use strict';

const fse = require('fs-extra');
const dot = require('dot-object');
const path = require('path');
const execa = require('execa');
const Plan = require('./terraform/plan');
const pjson = require('../package');
const State = require('./terraform/state');
const Downloader = require('./downloader');
const SecureOutput = require('./secure-output');
const { getFilesByPattern } = require('./helper/util');

/**
 * Terraform wrapper
 */
class Terraform {
  /**
   * @param {*} vars
   * @param {String} binary
   * @param {String} resource
   * @param {Array} varFiles
   */
  constructor(
    vars = {},
    binary = Terraform.BINARY,
    resource = Terraform.RESOURCE,
    varFiles = []
  ) {
    this._vars = vars;
    this._binary = binary;
    this._resource = resource;
    this._varFiles = varFiles;
    this._logger = false;
    this._isRemoteState = false;
  }

  /**
   * @param {string} name
   * 
   * @returns {boolean} 
   */
  hasVar(name) {
    return this._vars.hasOwnProperty(name);
  }

  /**
   * @param {string} name 
   * @param {*} defaultValue 
   * 
   * @returns {*}
   */
  getVar(name, defaultValue = null) {
    if (!this.hasVar(name)) {
      return defaultValue;
    }

    return this._vars[name];
  }

  /**
   * @param {string} name 
   * @param {*} value 
   * 
   * @returns {Terraform}
   */
  setVar(name, value) {
    this._vars[name] = value;

    return this;
  }

  /**
   * @param {*} vars 
   * 
   * @returns {Terraform}
   */
  setVars(vars) {
    this._vars = vars;

    return this;
  }

  /**
   * @returns {*}
   */
  get vars() {
    return this._vars;
  }

  /**
   * @returns {string}
   */
  get getBinary() {
    return this._binary;
  }

  /**
   * @returns {string}
   */
  get getResource() {
    return this._resource;
  }

  /**
   * @returns {Array}
   */
  get varFiles() {
    return this._varFiles;
  }

  /**
   * @returns {*}
   */
  get env() {
    const env = {};

    Object.keys(this.vars).forEach(name => {
      env[`TF_VAR_${ name }`] = this.vars[name];
    });

    return env;
  }

  /**
   * https://www.terraform.io/docs/commands/init.html
   * @param {string} dir
   * @returns {Promise}
   */
  init(dir) {
    return this
      .run('init', ['-no-color', '.'], dir)
      .then(() => this.checkRemoteState(dir))
      .then(() => Promise.resolve());
  }

  /**
   * Check if remote state configured
   * @param {String} dir
   * @return {Promise}
   */
  checkRemoteState(dir) {
    const statePath = path.join(dir, '.terraform', Terraform.STATE);

    if (!fse.existsSync(statePath)) {
      return Promise.resolve();
    }

    return fse.readJson(statePath).then(stateObj => {
      this._isRemoteState = !!dot.pick('backend.type', stateObj);
      return Promise.resolve();
    });
  }

  /**
   * https://www.terraform.io/docs/commands/state/index.html
   * @param {string} dir
   * @returns {Promise}
   */
  pullState(dir) {
    return this._ensureResourceDir(dir).then(() => {
      return this.run('state', ['pull'], dir).then(result => {
        if (this._isRemoteState && result.output) {
          const remoteStatePath = path.join(dir, this.getResource, Terraform.REMOTE);
          const backupStatePath = path.join(dir, this.getResource, Terraform.BACKUP);

          if (fse.existsSync(remoteStatePath)) {
            fse.moveSync(remoteStatePath, backupStatePath);
          }

          fse.writeFileSync(remoteStatePath, result.output, 'utf8');
        }

        return Promise.resolve();
      });
    });
  }

  /**
   * https://www.terraform.io/docs/commands/plan.html
   * @param {string} dir
   * @returns {Promise}
   */
  plan(dir) {
    return this._ensureResourceDir(dir).then(() => {
      const localStatePath = path.join(dir, this.getResource, Terraform.STATE);
      const planPath = path.join(dir, this.getResource, Terraform.PLAN);
      let options = ['-no-color', `-out=${planPath}`];

      this.varFiles.forEach(fileName => {
        options.push(`-var-file=${path.join(dir, fileName)}`);
      });

      if (!this._isRemoteState && fse.existsSync(localStatePath)) {
        options.push(`-state=${localStatePath}`);
      }

      return this.run('plan', options, dir).then(result => new Plan(planPath, result.output));
    });
  }

  /**
   * https://www.terraform.io/docs/commands/apply.html
   *
   * @param {string} dir
   *
   * @returns {Promise}
   */
  apply(dir) {
    return this._ensureResourceDir(dir).then(() => {
      const planPath = path.join(dir, this.getResource, Terraform.PLAN);
      const localStatePath = path.join(dir, this.getResource, Terraform.STATE);
      const remoteStatePath = path.join(dir, this.getResource, Terraform.REMOTE);
      const backupStatePath = path.join(dir, this.getResource, Terraform.BACKUP);
      let options = ['-no-color', '-auto-approve'];

      if (!this._isRemoteState && fse.existsSync(localStatePath)) {
        this.varFiles.forEach(fileName => {
          options.push(`-var-file=${path.join(dir, fileName)}`);
        });

        options.push(
          `-state=${ localStatePath }`,
          `-state-out=${ localStatePath }`,
          `-backup=${ backupStatePath }`
        );
      } else if (fse.existsSync(planPath)) {
        if (!this._isRemoteState) {
          options.push(`-state-out=${ localStatePath }`);
        }
        options.push(planPath);
      }

      return this.run('apply', options, dir).then(() => {
        if (this._isRemoteState) {
          return this.pullState(dir).then(() => Promise.resolve(new State(remoteStatePath, backupStatePath)));
        }

        return Promise.resolve(new State(localStatePath, backupStatePath));
      });
    });
  }

  /**
   * https://www.terraform.io/docs/commands/destroy.html
   * @param {string} dir
   * @returns {Promise}
   */
  destroy(dir) {
    return this._ensureResourceDir(dir).then(() => {
      const localStatePath = path.join(dir, this.getResource, Terraform.STATE);
      const backupStatePath = path.join(dir, this.getResource, Terraform.BACKUP);
      let options = ['-no-color', '-force'];

      this.varFiles.forEach(fileName => {
        options.push(`-var-file=${path.join(dir, fileName)}`);
      });

      if (!this._isRemoteState && fse.existsSync(localStatePath)) {
        options.push(
          `-state=${ localStatePath }`,
          `-state-out=${ localStatePath }`,
          `-backup=${ backupStatePath }`
        );
      }

      return this.run('destroy', options, dir).then(() => {
        let state = new State(localStatePath, backupStatePath);

        if (!this._isRemoteState) {
          return Promise.resolve(state);
        }

        return this.pullState(dir).then(() => Promise.resolve(state));
      });
    });
  }

  /**
   * https://www.terraform.io/docs/commands/show.html
   * 
   * @param {Plan|State} planOrState
   * @param {Boolean} secureOutput
   * @returns {Promise} 
   */
  show(planOrState, secureOutput = true) {
    let options = ['-no-color'];

    if (planOrState.path) {
      options.push(planOrState.path);
    }

    return this.run('show', options, planOrState.dir).then(result => {
      return Promise.resolve(
        secureOutput 
          ? SecureOutput.secure(result.output) 
          : result.output
      );
    });
  }

  /**
   * @param {string} dir
   * @returns {Promise}
   * @private
   */
  _ensureResourceDir(dir) {
    return fse.ensureDir(path.join(dir, this.getResource));
  }

  /**
   * @param {String} command
   * @param {Array} args
   * @param {String} cwd
   * @returns {Promise}
   */
  run(command, args = [], cwd = process.cwd()) {
    const { env } = this;

    if (this.logger) {
      this.logger.debug({
        command: `${this.getBinary} ${command}`,
        args: args,
        fileNames: getFilesByPattern(cwd, /.*/)
      });
    }

    return execa(
      path.resolve(this.getBinary),
      [ command ].concat(args),
      { env, cwd }
    ).then(result => {
      const { stdout, code } = result;

      return Promise.resolve({ code, output: stdout });
    });
  }

  /**
   * @param {string} version
   *
   * @returns {Promise}
   */
  ensure(version = Terraform.VERSION) {
    return fse.pathExists(this.getBinary).then(exists => {
      if (exists) {
        return Promise.resolve();
      }

      // @todo rethink this logic
      const downloader = new Downloader();
      const dir = path.dirname(this.getBinary);

      // @todo validate version to follow format X.Y.Z
      return downloader.download(dir, version).then(() => {
        const realPath = path.join(dir, Terraform.BIN_FILE);

        if (realPath === this.getBinary) {
          return Promise.resolve();
        }

        return fse.move(realPath, this.getBinary);
      });
    });
  }

  /**
   * @return {boolean|*}
   */
  get logger() {
    return this._logger;
  }

  /**
   * @param {*} logger
   * @return {Terraform}
   */
  setLogger(logger) {
    this._logger = logger;

    return this;
  }

  /**
   * @returns {string}
   */
  static get VERSION() {
    const { version } = pjson.terraform || '0.10.4';
    return version;
  }

  /**
   * @returns {string}
   */
  static get PLAN() {
    return 'terraform.tfplan';
  }

  /**
   * @returns {string}
   */
  static get STATE() {
    return 'terraform.tfstate';
  }

  /**
   * @returns {string}
   */
  static get REMOTE() {
    return 'terraform.tfstate.remote';
  }

  /**
   * @returns {string}
   */
  static get BACKUP() {
    return `terraform.tfstate.${ new Date().getTime() }.backup`;
  }

  /**
   * @returns {string}
   */
  static get RESOURCE() {
    return '.resource';
  }

  /**
   * @returns {string}
   */
  static get BIN_PATH() {
    return path.resolve(process.cwd(), 'bin');
  }

  /**
   * @returns {string}
   */
  static get BIN_FILE() {
    return 'terraform';
  }

  /**
   * @returns {string}
   */
  static get BINARY() {
    return path.join(Terraform.BIN_PATH, Terraform.BIN_FILE);
  }
}

module.exports = Terraform;
