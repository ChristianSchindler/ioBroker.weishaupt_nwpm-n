"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_puppeteer = __toESM(require("puppeteer"));
var import_fs = __toESM(require("fs"));
var import_pdf_parse = __toESM(require("pdf-parse"));
class WeishauptNwpmN extends utils.Adapter {
  taskInterval = null;
  constructor(options = {}) {
    super({
      ...options,
      name: "weishaupt_nwpm-n"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async scrapeAndSavePDF(url, outputPath = "page.pdf") {
    const browser = await import_puppeteer.default.launch({
      headless: true,
      args: ["--lang=en"]
    });
    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: "networkidle2"
      // ensures the page is fully loaded
    });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true
    });
    this.log.info(`PDF saved to ${outputPath}`);
    await browser.close();
  }
  async convertPDFtoJSON(pdfPath = "page.pdf") {
    const dataBuffer = import_fs.default.readFileSync(pdfPath);
    const data = await (0, import_pdf_parse.default)(dataBuffer);
    const validHeaders = [
      "heating circuit 1",
      "domestic hot water",
      "solar storage",
      "heat pump"
    ];
    const generalParams = [
      "external temperature",
      "flow temperature",
      "heating request",
      "performance level"
    ];
    const jsonOutput = {
      content: []
    };
    let currentHeader = null;
    let currentSubpoints = [];
    const generalSection = {
      header: "general",
      subpoints: []
    };
    const lines = data.text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    lines.forEach((line) => {
      if (validHeaders.includes(line)) {
        if (currentHeader) {
          jsonOutput.content.push({
            header: currentHeader,
            subpoints: currentSubpoints
          });
        }
        currentHeader = line;
        currentSubpoints = [];
      } else if (generalParams.some((param) => line.includes(param))) {
        const match = line.match(/([a-zA-Z\s]+)(\d+(\.\d+)?)/);
        if (match) {
          generalSection.subpoints.push({
            key: match[1].trim(),
            value: match[2].trim()
          });
        }
      } else {
        const match = line.match(/([a-zA-Z\s]+)(\d+(\.\d+)?)/);
        if (match) {
          currentSubpoints.push({
            key: match[1].trim(),
            value: match[2].trim()
          });
        }
      }
    });
    if (generalSection.subpoints.length > 0) {
      jsonOutput.content.push(generalSection);
    }
    if (currentHeader) {
      jsonOutput.content.push({
        header: currentHeader,
        subpoints: currentSubpoints
      });
    }
    for (const category in jsonOutput.content) {
      this.log.info(jsonOutput.content[category]["header"]);
      await this.setObjectNotExistsAsync(jsonOutput.content[category]["header"], {
        type: "channel",
        common: {
          name: jsonOutput.content[category]["header"]
        },
        native: {}
      });
      for (const value in jsonOutput.content[category]["subpoints"]) {
        this.log.info(jsonOutput.content[category]["subpoints"][value]["key"]);
        this.log.info(jsonOutput.content[category]["subpoints"][value]["value"]);
        await this.setObjectNotExistsAsync(jsonOutput.content[category]["header"] + "." + jsonOutput.content[category]["subpoints"][value]["key"], {
          type: "state",
          common: {
            role: "text",
            name: jsonOutput.content[category]["subpoints"][value]["key"],
            type: "string",
            read: true,
            write: false
          },
          native: {}
        });
        this.setStateAsync(jsonOutput.content[category]["header"] + "." + jsonOutput.content[category]["subpoints"][value]["key"], jsonOutput.content[category]["subpoints"][value]["value"]);
      }
    }
    return;
  }
  async scrape_operating_data() {
    this.log.info("scrape");
    await this.scrapeAndSavePDF(this.config.url + "/http/index/j_operatingdata.html");
    await this.convertPDFtoJSON();
  }
  /**
   * @private
   * This is the main method with scrapes the website
   */
  async scrapeNWPMN() {
    this.log.info("scrape");
    await this.scrape_operating_data();
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    this.setState("info.connection", false, true);
    if (!this.config.url) {
      this.log.error("please specify a URL");
      return;
    }
    try {
      new URL(this.config.url);
      this.log.debug("config url: " + this.config.url);
    } catch (_) {
      this.log.error("yor url is not valid: " + this.config.url);
      return;
    }
    this.taskInterval = setInterval(() => {
      this.scrapeNWPMN();
    }, this.config.interval * 1e3);
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   */
  onUnload(callback) {
    try {
      if (this.taskInterval)
        clearInterval(this.taskInterval);
      callback();
    } catch (e) {
      callback();
    }
  }
  // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
  // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
  // /**
  //  * Is called if a subscribed object changes
  //  */
  // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
  //     if (obj) {
  //         // The object was changed
  //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
  //     } else {
  //         // The object was deleted
  //         this.log.info(`object ${id} deleted`);
  //     }
  // }
  // /**
  // * Is called if a subscribed state changes
  // */
  // private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
  //     if (state) {
  //         // The state was changed
  //         this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
  //     } else {
  //         // The state was deleted
  //         this.log.info(`state ${id} deleted`);
  //     }
  // }
  // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
  // /**
  //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
  //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
  //  */
  // private onMessage(obj: ioBroker.Message): void {
  //     if (typeof obj === 'object' && obj.message) {
  //         if (obj.command === 'send') {
  //             // e.g. send email or pushover or whatever
  //             this.log.info('send command');
  //             // Send response in callback if required
  //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
  //         }
  //     }
  // }
}
if (require.main !== module) {
  module.exports = (options) => new WeishauptNwpmN(options);
} else {
  (() => new WeishauptNwpmN())();
}
//# sourceMappingURL=main.js.map
