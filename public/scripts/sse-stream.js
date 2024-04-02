import { power_user } from './power-user.js';
import { delay } from './utils.js';

/**
 * A stream which handles Server-Sent Events from a binary ReadableStream like you get from the fetch API.
 */
class EventSourceStream {
    constructor() {
        const decoder = new TextDecoderStream('utf-8');

        let streamBuffer = '';
        let lastEventId = '';

        function processChunk(controller) {
            // Events are separated by two newlines
            const events = streamBuffer.split(/\r\n\r\n|\r\r|\n\n/g);
            if (events.length === 0) return;

            // The leftover text to remain in the buffer is whatever doesn't have two newlines after it. If the buffer ended
            // with two newlines, this will be an empty string.
            streamBuffer = events.pop();

            for (const eventChunk of events) {
                let eventType = '';
                // Split up by single newlines.
                const lines = eventChunk.split(/\n|\r|\r\n/g);
                let eventData = '';
                for (const line of lines) {
                    const lineMatch = /([^:]+)(?:: ?(.*))?/.exec(line);
                    if (lineMatch) {
                        const field = lineMatch[1];
                        const value = lineMatch[2] || '';

                        switch (field) {
                            case 'event':
                                eventType = value;
                                break;
                            case 'data':
                                eventData += value;
                                eventData += '\n';
                                break;
                            case 'id':
                                // The ID field cannot contain null, per the spec
                                if (!value.includes('\0')) lastEventId = value;
                                break;
                            // We do nothing for the `delay` type, and other types are explicitly ignored
                        }
                    }
                }


                // https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage
                // Skip the event if the data buffer is the empty string.
                if (eventData === '') continue;

                if (eventData[eventData.length - 1] === '\n') {
                    eventData = eventData.slice(0, -1);
                }

                // Trim the *last* trailing newline only.
                const event = new MessageEvent(eventType || 'message', { data: eventData, lastEventId });
                controller.enqueue(event);
            }
        }

        const sseStream = new TransformStream({
            transform(chunk, controller) {
                streamBuffer += chunk;
                processChunk(controller);
            },
        });

        decoder.readable.pipeThrough(sseStream);

        this.readable = sseStream.readable;
        this.writable = decoder.writable;
    }
}

const defaultDelayMs = 20;
const punctuationDelayMs = 500;

/**
 * Gets a delay based on the character.
 * @param {string} s The character.
 * @returns {number} The delay in milliseconds.
 */
function getDelay(s) {
    if (!s) {
        return 0;
    }

    if ([',', '\n'].includes(s)) {
        return punctuationDelayMs / 2;
    }

    if (['.', '!', '?'].includes(s)) {
        return punctuationDelayMs;
    }

    return defaultDelayMs;
}

/**
 * Parses the stream data and returns the parsed data and the chunk to be sent.
 * @param {object} json The JSON data.
 * @returns {AsyncGenerator<{data: object, chunk: string} | null>} The parsed data and the chunk to be sent.
 */
async function* parseStreamData(json) {
    // Claude
    if (typeof json.delta === 'object') {
        if (typeof json.delta.text === 'string' && json.delta.text.length > 0) {
            for (let i = 0; i < json.delta.text.length; i++) {
                const str = json.delta.text[i];
                yield {
                    data: { ...json, delta: { text: str } },
                    chunk: str,
                };
            }
        }
    }
    // MakerSuite
    else if (Array.isArray(json.candidates)) {
        for (let i = 0; i < json.candidates.length; i++) {
            if (typeof json.candidates[i].content === 'string' && json.candidates[i].content.length > 0) {
                for (let j = 0; j < json.candidates[i].content.length; j++) {
                    const str = json.candidates[i].content[j];
                    const candidatesClone = structuredClone(json.candidates[i]);
                    candidatesClone[i].content = str;
                    yield {
                        data: { ...json, candidates: candidatesClone },
                        chunk: str,
                    };
                }
            }
        }
    }
    // NovelAI / KoboldCpp Classic
    else if (typeof json.token === 'string' && json.token.length > 0) {
        for (let i = 0; i < json.token.length; i++) {
            const str = json.token[i];
            yield {
                data: { ...json, token: str },
                chunk: str,
            };
        }
    }
    // llama.cpp?
    else if (typeof json.content === 'string' && json.content.length > 0) {
        for (let i = 0; i < json.content.length; i++) {
            const str = json.content[i];
            yield {
                data: { ...json, content: str },
                chunk: str,
            };
        }
    }
    // OpenAI-likes
    else if (Array.isArray(json.choices)) {
        const isNotPrimary = json?.choices?.[0]?.index > 0;
        if (isNotPrimary || json.choices.length === 0) {
            return null;
        }
        if (typeof json.choices[0].delta === 'object') {
            if (typeof json.choices[0].delta.text === 'string' && json.choices[0].delta.text.length > 0) {
                for (let j = 0; j < json.choices[0].delta.text.length; j++) {
                    const str = json.choices[0].delta.text[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.text = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
            } else if (typeof json.choices[0].delta.content === 'string' && json.choices[0].delta.content.length > 0) {
                for (let j = 0; j < json.choices[0].delta.content.length; j++) {
                    const str = json.choices[0].delta.content[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.content = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
            }
        }
        else if (typeof json.choices[0].message === 'object') {
            if (typeof json.choices[0].message.content === 'string' && json.choices[0].message.content.length > 0) {
                for (let j = 0; j < json.choices[0].message.content.length; j++) {
                    const str = json.choices[0].message.content[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.message.content = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
            }
        }
        else if (typeof json.choices[0].text === 'string' && json.choices[0].text.length > 0) {
            for (let j = 0; j < json.choices[0].text.length; j++) {
                const str = json.choices[0].text[j];
                const choiceClone = structuredClone(json.choices[0]);
                choiceClone.text = str;
                const choices = [choiceClone];
                yield {
                    data: { ...json, choices },
                    chunk: str,
                };
            }
        }
    }

    return null;
}

/**
 * Like the default one, but multiplies the events by the number of letters in the event data.
 */
export class SmoothEventSourceStream extends EventSourceStream {
    constructor() {
        super();
        let lastStr = '';
        const transformStream = new TransformStream({
            async transform(chunk, controller) {
                const event = chunk;
                const data = event.data;
                try {
                    const json = JSON.parse(data);

                    if (!json) {
                        lastStr = '';
                        return controller.enqueue(event);
                    }

                    for await (const parsed of parseStreamData(json)) {
                        if (!parsed) {
                            lastStr = '';
                            return controller.enqueue(event);
                        }

                        await delay(getDelay(lastStr));
                        controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify(parsed.data) }));
                        lastStr = parsed.chunk;
                    }
                } catch {
                    controller.enqueue(event);
                }
            },
        });

        this.readable = this.readable.pipeThrough(transformStream);
    }
}

export function getEventSourceStream() {
    if (power_user.smooth_streaming) {
        return new SmoothEventSourceStream();
    }

    return new EventSourceStream();
}

export default EventSourceStream;
