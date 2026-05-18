const { v4: uuidv4 } = require('uuid');

const workers = new Map();
const jobs = new Map();

function initWorkerSocket(io) {
    io.on('connection', (socket) => {
        console.log('🔌 Worker connected:', socket.id);

        socket.on('REGISTER_WORKER', (data = {}) => {
            const workerId = uuidv4();

            workers.set(workerId, {
                socket,
                workerId,
                apiKey: data.apiKey || '',
                name: data.name || 'Worker',
                onlineAt: new Date()
            });

            socket.emit('REGISTERED', { workerId });
            console.log(`✅ Worker registered: ${workerId} | API Key: ${data.apiKey || ''}`);
        });

        socket.on('JOB_RESULT', ({ jobId, output }) => {
            const job = jobs.get(jobId);
            if (job) {
                job.status = 'completed';
                job.output = output;
                job.finishedAt = new Date();
                console.log(`✅ Job ${jobId} completed`);
            } else {
                console.log(`⚠️ JOB_RESULT received but job not found: ${jobId}`);
            }
        });

        socket.on('disconnect', () => {
            for (const [id, w] of workers) {
                if (w.socket.id === socket.id) {
                    workers.delete(id);
                    console.log(`❌ Worker disconnected: ${id}`);
                    break;
                }
            }
        });
    });

    return { workers, jobs };
}

module.exports = { initWorkerSocket };