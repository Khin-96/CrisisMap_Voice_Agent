const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

const PORT = process.env.VOICE_PORT || process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const HOST = "generativelanguage.googleapis.com";
const GEMINI_WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// --- Audio Utilities ---

const MuLaw = {
    decode: function (muLaw) {
        muLaw = ~muLaw;
        let sign = (muLaw & 0x80);
        let exponent = (muLaw & 0x70) >> 4;
        let mantissa = muLaw & 0x0F;
        let sample = (mantissa << 3) + 0x84;
        sample <<= exponent;
        sample = (sign !== 0) ? (0x84 - sample) : (sample - 0x84);
        return sample;
    },
    encode: function (sample) {
        const sign = (sample < 0) ? 0x80 : 0x00;
        if (sample < 0) sample = -sample;
        sample += 0x84;
        if (sample > 32767) sample = 32767;
        let exponent = 7;
        let expMask = 0x4000;
        while (exponent > 0 && (sample & expMask) === 0) {
            exponent--;
            expMask >>= 1;
        }
        let mantissa = (sample >> (exponent + 3)) & 0x0F;
        return ~(sign | (exponent << 4) | mantissa);
    }
};

/**
 * Convert 8kHz mu-law (Twilio) to 24kHz 16-bit PCM (Gemini)
 * Tripling every sample for clean upsampling.
 */
function twilioToPcm(base64Payload) {
    const buffer = Buffer.from(base64Payload, 'base64');
    const pcm = Buffer.alloc(buffer.length * 2 * 3); // 2 bytes per sample, tripled
    for (let i = 0; i < buffer.length; i++) {
        const sample = MuLaw.decode(buffer[i]);
        // Write the same sample 3 times for 8k -> 24k
        for (let j = 0; j < 3; j++) {
            pcm.writeInt16LE(sample, (i * 3 + j) * 2);
        }
    }
    return pcm;
}

/**
 * Convert 24kHz 16-bit PCM (Gemini) to 8kHz mu-law (Twilio)
 * Taking every 3rd sample for clean downsampling.
 */
function pcmToTwilio(base64Payload) {
    const buffer = Buffer.from(base64Payload, 'base64');
    const numSamples = Math.floor(buffer.length / 2);
    const mulaw = Buffer.alloc(Math.floor(numSamples / 3));

    for (let i = 0; i < mulaw.length; i++) {
        // Read 16-bit Little Endian sample from Gemini
        const sample = buffer.readInt16LE(i * 3 * 2);
        mulaw[i] = MuLaw.encode(sample);
    }
    return mulaw.toString('base64');
}

// --- Express Endpoints ---

app.post('/voice', (req, res) => {
    console.log('[voice] Incoming call request');
    const twiml = new twilio.twiml.VoiceResponse();

    try {
        twiml.say({ voice: 'Google.en-US-Standard-C' }, "Hello, this is Agrivision. What can I do for you today?");

        const connect = twiml.connect();
        const streamUrl = `wss://${req.headers.host}/media-stream`;
        console.log(`[voice] Connecting stream to: ${streamUrl}`);

        connect.stream({
            url: streamUrl,
        });

        res.type('text/xml');
        res.send(twiml.toString());
        console.log('[voice] TwiML response sent');
    } catch (err) {
        console.error('[voice] Error generating TwiML:', err);
        res.status(500).send('Error');
    }
});

app.get('/health', (req, res) => {
    res.send({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- WebSocket Bridge Logic ---

wss.on('connection', (ws) => {
    console.log('[Twilio] Stream connection established');

    let geminiWs = null;
    let streamSid = null;

    const connectToGemini = () => {
        geminiWs = new WebSocket(GEMINI_WS_URL);

        geminiWs.on('open', () => {
            console.log('[Gemini] Connection opened');
            const setup = {
                setup: {
                    model: MODEL,
                    generation_config: {
                        response_modalities: ["AUDIO"],
                        speech_config: {
                            voice_config: {
                                prebuilt_voice_config: {
                                    voice_name: "Aoede"
                                }
                            }
                        }
                    },
                    system_instruction: {
                        parts: [{
                            text: "You are Vision AI, a helpful agricultural assistant. You are talking to a farmer on the phone. Keep your responses extremely brief (1-2 sentences). Be conversational and helpful."
                        }]
                    }
                }
            };
            geminiWs.send(JSON.stringify(setup));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data.toString());
                console.log('[Gemini] Received message:', JSON.stringify(response, null, 2));

                if (response.setupComplete) {
                    console.log('[Gemini] Setup complete');
                    const initialTurn = {
                        client_content: {
                            turns: [{
                                role: "user",
                                parts: [{ text: "The user has just joined the call. Please introduce yourself and ask how you can help." }]
                            }],
                            turn_complete: true
                        }
                    };
                    geminiWs.send(JSON.stringify(initialTurn));
                    return;
                }

                if (response.serverContent?.interrupted) {
                    console.log('[Gemini] Interrupted');
                    if (ws.readyState === WebSocket.OPEN && streamSid) {
                        ws.send(JSON.stringify({
                            event: 'clear',
                            streamSid: streamSid
                        }));
                    }
                }

                if (response.serverContent?.modelTurn?.parts) {
                    const parts = response.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.inlineData && part.inlineData.mimeType.includes('audio/pcm')) {
                            const twilioPayload = pcmToTwilio(part.inlineData.data);
                            if (ws.readyState === WebSocket.OPEN && streamSid) {
                                ws.send(JSON.stringify({
                                    event: 'media',
                                    streamSid: streamSid,
                                    media: {
                                        payload: twilioPayload
                                    }
                                }));
                            }
                        }
                        if (part.text) {
                            console.log(`[Gemini]: ${part.text}`);
                        }
                    }
                }
            } catch (err) {
                console.error('[Gemini] Error processing message:', err);
            }
        });

        geminiWs.on('error', (err) => {
            console.error('[Gemini] WebSocket error:', err);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`[Gemini] Connection closed. Code: ${code}, Reason: ${reason}`);
        });
    };

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.event) {
            case 'start':
                streamSid = data.start.streamSid;
                console.log(`[Twilio] Stream started for SID: ${streamSid}`);
                connectToGemini();
                break;
            case 'media':
                if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                    const pcmData = twilioToPcm(data.media.payload);
                    const geminiMessage = {
                        realtime_input: {
                            media_chunks: [{
                                mime_type: "audio/pcm;rate=24000",
                                data: pcmData.toString('base64')
                            }]
                        }
                    };
                    geminiWs.send(JSON.stringify(geminiMessage));
                }
                break;
            case 'stop':
                console.log('[Twilio] Stream stopped');
                if (geminiWs) geminiWs.close();
                break;
        }
    });

    ws.on('close', () => {
        console.log('[Twilio] Connection closed');
        if (geminiWs) geminiWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`Smooth Voice Server running at port ${PORT}`);
    console.log(`Twilio Webhook (Voice): POST /voice`);
    console.log(`========================================\n`);
});
