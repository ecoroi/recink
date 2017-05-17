'use strict';

const ConfigBasedComponent = require('./config-based-component');
const istanbul = require('istanbul');
const testEvents = require('./test/events');
const ContainerTransformer = require('./helper/container-transformer');
const md5Hex = require('md5-hex');
const path = require('path');
const fs = require('fs');
const requireHacker = require('require-hacker');
const storageFactory = require('./coverage/factory');

class CoverageComponent extends ConfigBasedComponent {
  /**
   * @param {*} args
   */
  constructor(...args) {
    super(...args);
    
    this._storage = null;
  }
  
  /**
   * @returns {string}
   */
  get name() {
    return 'coverage';
  }
  
  /**
   * @returns {AbstractDriver}
   *
   * @private
   */
  get _comparatorStorage() {
    if (this._storage) {
      return this._storage;
    }
    
    const driver = this.container.get('compare.storage.driver', 'volatile');
    const options = this.container.get('compare.storage.options', []);
    
    this._storage = storageFactory[driver](...options);
    
    return this._storage;
  }
  
  /**
   * @param {istanbul.Collector} collector
   *
   * @returns {promise}
   * 
   * @private
   */
  _doCompare(collector) {
    const allowedDelta = Math.abs(parseFloat(
      this.container.get('compare.negative-delta', 100)
    ));
    
    if (!allowedDelta || allowedDelta >= 100) {
      return Promise.resolve();
    }
    
    const storage = this._comparatorStorage;
    
    if (storage.constructor.name === 'VolatileDriver') {
      this.logger.debug(
        `Coverage stored in ${ storage._storageFile(CoverageComponent.COVERAGE_FILE) }`
      );
    }
    
    return storage.read(CoverageComponent.COVERAGE_FILE)
      .then(coverage => {
        const newCoverage = collector.getFinalCoverage();
        
        if (!coverage) {
          this.logger.debug('No saved coverage info, saving the new one...');
          
          return storage.write(
            CoverageComponent.COVERAGE_FILE, 
            newCoverage
          );
        }
        
        const delta = this._calculateDelta(coverage, newCoverage);
        
        if (delta > allowedDelta) {          
          return Promise.reject(new Error(
            `Coverage delta decreased ${ delta.toFixed(2) } > ${ allowedDelta.toFixed(2) }`
          ));
        }
        
        this.logger.info(
          this.logger.emoji.bicycle,
          `Coverage delta checked ${ delta.toFixed(2) } >= ${ allowedDelta.toFixed(2) }`
        );
        
        return storage.write(
          CoverageComponent.COVERAGE_FILE, 
          newCoverage
        );
      });
  }
  
  /**
   * @param {*} coverage
   * @param {*} newCoverage
   *
   * @returns {number}
   *
   * @private
   */
  _calculateDelta(coverage, newCoverage) {
    const summary = this._summarizeCoverage(coverage);
    const newSummary = this._summarizeCoverage(newCoverage);
    
    return CoverageComponent.COVERAGE_KEYS
      .reduce((accumulator, key) => {
        return accumulator + 
          parseFloat(summary[key]) - 
          parseFloat((newSummary[key] || 0));
      }, 0) / CoverageComponent.COVERAGE_KEYS.length;
  }
  
  /**
   * @param {*} coverage
   *
   * @returns {*}
   *
   * @private
   */
  _summarizeCoverage(coverage) {
    const summary = {};
    
    const summaries = Object.keys(coverage)
      .map(file => {
        return istanbul.utils
          .summarizeFileCoverage(coverage[file]);
      });
    
    const summaryObj = istanbul.utils
      .mergeSummaryObjects
      .apply(null, summaries);
    
    Object.keys(summaryObj)
      .map(key => {
        summary[key] = summaryObj[key].pct;
      });
      
    return summary;
  }
  
  /**
   * @param {Emitter} emitter
   * 
   * @returns {promise}
   */
  run(emitter) {
    return new Promise((resolve, reject) => {
      const collector = new istanbul.Collector();
      const reporter = new istanbul.Reporter();
      const reporters = this.container.get('reporters', {});
      const coverageVariables = [];
      
      Object.keys(reporters).map(reporterName => {
        const report = istanbul.Report.create(
          reporterName, 
          reporters[reporterName] || {}
        );
        
        reporter.reports[reporterName] = report;
      });
      
      emitter.onBlocking(testEvents.asset.test.start, (testAsset, mocha) => {
        const coverageVariable = this._coverageVariable(testAsset);
        const instrumenter = new istanbul.Instrumenter({ coverageVariable });
        
        coverageVariables.push(coverageVariable);

        mocha.loadFiles = (fn => {
          const moduleRoot = testAsset.module.container.get('root');
          
          mocha.files.map(file => {
            file = path.resolve(file);
            mocha.suite.emit('pre-require', global, file, mocha);
            
            // @todo add other extensions to be covered
            const requireHook = requireHacker.hook('js', depPath => {
              if (depPath.indexOf(moduleRoot) === 0
                && this._match(path.relative(moduleRoot, depPath))) {
                
                return instrumenter.instrumentSync(
                  fs.readFileSync(depPath).toString(), 
                  depPath
                );
              }
            });
            mocha.suite.emit('require', require(file), file, mocha);            
            requireHook.unmount();
            
            mocha.suite.emit('post-require', global, file, mocha);
          });
          
          fn && fn();
        });
        
        return Promise.resolve();
      });
      
      emitter.onBlocking(testEvents.assets.test.end, () => {
        coverageVariables.map(coverageVariable => {
          collector.add(global[coverageVariable] || {});
        });
        
        return this._dumpCoverageStats(collector, reporter)
          .then(() => this._doCompare(collector));
      });
      
      emitter.on(testEvents.assets.test.end, () => resolve());
    });
  }
  
  /**
   * @param {istanbul.Collector} collector
   * @param {istanbul.Reporter} reporter
   *
   * @returns {promise}
   * 
   * @private
   */
  _dumpCoverageStats(collector, reporter) {
    return new Promise(resolve => {
      reporter.write(collector, false, () => {
        
        // @todo find a smarter way to indent the output (buffer it?)
        process.stdout.write('\n\n');
        
        resolve();
      });
    });
  }
  
  /**
   * @param {string} testAsset
   *
   * @returns {string}
   *
   * @private
   */
  _coverageVariable(testAsset) {
    const cleanModuleName = testAsset.module.name.replace(/[^a-z0-9]/g, '_');
    const assetHash = md5Hex(testAsset.file);
    
    return `__jst_coverage__${ cleanModuleName }__${ assetHash }__`;
  }
  
  /**
   * @param {string} file
   *
   * @returns {boolean}
   * 
   * @private
   */
  _match(file) {
    const pattern = this.container.get('pattern', []);
    const ignore = this.container.get('ignore', []);

    const result = pattern.filter(p => this._test(p, file)).length > 0
      && ignore.filter(i => this._test(i, file)).length <= 0;
      
    return result;
  }
  
  /**
   * @param {string|RegExp} pattern
   * @param {string} value
   *
   * @returns {boolean}
   *
   * @private
   */
  _test(pattern, value) {
    if (!(pattern instanceof RegExp)) {
      return value.indexOf(pattern.toString()) !== -1;
    }
    
    return pattern.test(value);
  }
  
  /**
   * @param {*} config
   * @param {string} configFile
   *
   * @returns {Container}
   */
  prepareConfig(config, configFile) {
    return super.prepareConfig(config, configFile)
      .then(container => {
        return (new ContainerTransformer(container))
          .addPattern('pattern')
          .addPattern('ignore')
          .transform();
      });
  }
  
  /**
   * @returns {Array}
   */
  static get COVERAGE_KEYS() {
    return [ 'lines', 'statements', 'functions', 'branches' ];
  }
  
  /**
   * @returns {string}
   */
  static get COVERAGE_FILE() {
    return 'coverage.json';
  }
}

module.exports = CoverageComponent;