// Full connection test against correct IP
import net from 'node:net';
import tls from 'node:tls';
import mqtt from 'mqtt';

const IP = process.env.PRINTER_IP || '192.168.1.50';
const PORT = 8883;
const SERIAL = process.env.PRINTER_SERIAL || '00M00A123456789';
const ACCESS_CODE = process.env.PRINTER_ACCESS_CODE || '12345678';

async function testTls() {
    console.log(`\n=== TLS Handshake to ${IP}:${PORT} ===`);
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host: IP, port: PORT, rejectUnauthorized: false, timeout: 5000
        }, () => {
            const cert = socket.getPeerCertificate();
            console.log('✅ TLS OK');
            console.log(`   Fingerprint: ${cert.fingerprint256 || 'N/A'}`);
            socket.destroy();
            resolve();
        });
        socket.on('error', (err) => { console.log(`❌ TLS ERROR: ${err.message}`); reject(err); });
        socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS timeout')); });
    });
}

async function testMqtt() {
    console.log(`\n=== MQTT Connect ===`);
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(`mqtts://${IP}:${PORT}`, {
            clientId: `antigravity_test_${Date.now()}`,
            username: 'bblp',
            password: ACCESS_CODE,
            rejectUnauthorized: false,
            reconnectPeriod: 0,
            connectTimeout: 10000,
            protocolVersion: 4,
        });

        const timeout = setTimeout(() => {
            console.log('❌ MQTT TIMEOUT');
            client.end(true);
            reject(new Error('MQTT timeout'));
        }, 15000);

        client.on('connect', () => {
            console.log('✅ MQTT Connected');
            clearTimeout(timeout);

            const reportTopic = `device/${SERIAL}/report`;
            console.log(`\nSubscribing to ${reportTopic}...`);
            client.subscribe(reportTopic, (err) => {
                if (err) { console.log(`❌ Subscribe error: ${err.message}`); client.end(); reject(err); return; }
                console.log('✅ Subscribed');

                const requestTopic = `device/${SERIAL}/request`;
                client.publish(requestTopic, JSON.stringify({ pushing: { command: 'pushall' } }));
                console.log('✅ Pushall sent, waiting for report (up to 10s)...');
            });
        });

        client.on('message', (topic, message) => {
            try {
                const data = JSON.parse(message.toString());
                console.log(`\n=== REPORT RECEIVED ===`);
                if (data.print) {
                    const p = data.print;
                    console.log(`   State: ${p.gcode_state || 'N/A'}`);
                    console.log(`   Nozzle: ${p.nozzle_temper}°C`);
                    console.log(`   Bed: ${p.bed_temper}°C`);
                    console.log(`   Progress: ${p.mc_percent}%`);
                } else {
                    console.log(`   Keys: ${Object.keys(data).join(', ')}`);
                }
                console.log('\n✅✅✅ SUCCESS — Printer is communicating! ✅✅✅');
                clearTimeout(timeout);
                client.end();
                resolve(data);
            } catch (e) {
                console.log(`   Raw msg: ${message.toString().slice(0, 200)}`);
            }
        });

        client.on('error', (err) => {
            console.log(`❌ MQTT ERROR: ${err.message}`);
            clearTimeout(timeout);
            client.end(true);
            reject(err);
        });
    });
}

async function main() {
    try {
        await testTls();
        await testMqtt();
    } catch (err) {
        console.log(`\n❌ FAILED: ${err.message}`);
        process.exit(1);
    }
}

main();
