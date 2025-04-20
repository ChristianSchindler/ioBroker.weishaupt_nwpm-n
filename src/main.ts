/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';

// Load your modules here
import puppeteer from 'puppeteer';
import fs from 'fs';
import pdf from 'pdf-parse';

// Types
interface Subpoint {
    key: string;
    value: string;
}

interface Section {
    header: string;
    subpoints: Subpoint[];
}

interface JSONOutput {
    content: Section[];
}

class WeishauptNwpmN extends utils.Adapter {
    private taskInterval: NodeJS.Timeout | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'weishaupt_nwpm-n',
        });
        this.on('ready', this.onReady.bind(this));
        // this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async scrapeAndSavePDF(url: string, outputPath: string = 'page.pdf'): Promise<void> {
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--lang=en-GB']
        });
        const page = await browser.newPage();

        await page.goto(url, {
            waitUntil: 'networkidle2' // ensures the page is fully loaded
        });

        await page.pdf({
            path: outputPath,
            format: 'A4',
            printBackground: true
        });

        this.log.info(`PDF saved to ${outputPath}`);
        await browser.close();
    }

    async convertPDFtoJSON(pdfPath = 'page.pdf'): Promise<void> {

        const dataBuffer = fs.readFileSync(pdfPath);

        const data = await pdf(dataBuffer);

        // Define the specific headers we're interested in
        const validHeaders = [
            'heating circuit 1',
            'domestic hot water',
            'solar storage',
            'heat pump'
        ];

        // Specific parameters to be added under the 'general' category
        const generalParams = [
            'external temperature',
            'flow temperature',
            'heating request',
            'performance level'
        ];
        // This will hold the final grouped JSON data
        const jsonOutput: JSONOutput = {
            content: []
        };

        // Temporary variables to track the current header and its key-value pairs
        let currentHeader: any = null;
        let currentSubpoints: { key: string; value: string; }[] = [];

        // Create a 'general' section for the specified parameters
        const generalSection = {
            header: 'general',
            subpoints: []
        };

        // Process the text content, split by new lines, and trim any unnecessary spaces
        const lines = data.text
            .split('\n')
            .map((line: string) => line.trim())
            .filter((line: string | any[]) => line.length > 0);

        // Loop through each line to categorize headers and subpoints
        lines.forEach((line: string) => {
            // Check if the line matches a valid header
            if (validHeaders.includes(line)) {
                // If a valid header is found, push the previous header's data (if any) to the JSON
                if (currentHeader) {
                    jsonOutput.content.push({
                        header: currentHeader,
                        subpoints: currentSubpoints
                    });
                }

                // Start a new valid header and reset subpoints
                currentHeader = line;
                currentSubpoints = [];
            } else if (generalParams.some(param => line.includes(param))) {
                // If the line contains one of the general parameters, add it to the 'general' section
                const match = line.match(/([a-zA-Z\s]+)(\d+(\.\d+)?)/);
                if (match) {
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-expect-error
                    generalSection.subpoints.push({
                        key: match[1].trim(),
                        value: match[2].trim()
                    });
                }
            } else {
                // Otherwise, this is a subpoint (e.g., "temperature21.9°C")
                const match = line.match(/([a-zA-Z\s]+)(\d+(\.\d+)?)/);
                if (match) {
                    currentSubpoints.push({
                        key: match[1].trim(),
                        value: match[2].trim()
                    });
                }
            }
        });

        // After the loop, add the 'general' section (if it has data)
        if (generalSection.subpoints.length > 0) {
            jsonOutput.content.push(generalSection);
        }

        // After the loop, add the last section (if any)
        if (currentHeader) {
            jsonOutput.content.push({
                header: currentHeader,
                subpoints: currentSubpoints
            });
        }

        for (const category in jsonOutput.content) {
            //console.debug(jsonOutput.content[category]);
            this.log.info(jsonOutput.content[category]['header']);
            await this.setObjectNotExistsAsync(jsonOutput.content[category]['header'], {
                type: 'channel',
                common: {
                    name: jsonOutput.content[category]['header'],
                },
                native: {},
            });

            for (const value in jsonOutput.content[category]['subpoints']) {
                this.log.info(jsonOutput.content[category]['subpoints'][value]['key']);
                this.log.info(jsonOutput.content[category]['subpoints'][value]['value']);
                await this.setObjectNotExistsAsync(jsonOutput.content[category]['header'] + '.' + jsonOutput.content[category]['subpoints'][value]['key'], {
                    type: 'state',
                    common: {
                        role: 'text',
                        name: jsonOutput.content[category]['subpoints'][value]['key'],
                        type: 'string',
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                this.setStateAsync(jsonOutput.content[category]['header'] + '.' + jsonOutput.content[category]['subpoints'][value]['key'], jsonOutput.content[category]['subpoints'][value]['value'])
            }
        }
        return;
    }

    private async scrape_operating_data(): Promise<void> {
        this.log.info('scrape');
        await this.scrapeAndSavePDF(this.config.url + '/http/index/j_operatingdata.html');
        await this.convertPDFtoJSON();
    }

    /**
     * @private
     * This is the main method with scrapes the website
     */
    private async scrapeNWPMN(): Promise<void> {
        this.log.info('scrape');
        await this.scrape_operating_data();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);

        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        if (!this.config.url) {
            this.log.error('please specify a URL');
            return;
        }
        try {
            new URL(this.config.url);
            this.log.debug('config url: ' + this.config.url);
        } catch (_) {
            this.log.error('yor url is not valid: ' + this.config.url);
            return;
        }
        this.taskInterval = setInterval(() => {
            this.scrapeNWPMN();
        }, this.config.interval * 1000);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
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
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new WeishauptNwpmN(options);
} else {
    // otherwise start the instance directly
    (() => new WeishauptNwpmN())();
}