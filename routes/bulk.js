const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function ({ workers, jobs }) {
    const router = express.Router();

    router.post('/bulk', (req, res) => {
        const {
            items,
            webhookUrl,
            mode = 'webhook',
            apiKey,
            promptLanguage = 'English',
            targetSite = 'grok.com'
        } = req.body;

        console.log('📥 Nhận POST /api/bulk:', {
            apiKey,
            itemsCount: Array.isArray(items) ? items.length : 0,
            mode,
            promptLanguage,
            targetSite
        });

        let targetWorker = null;
        for (const w of workers.values()) {
            if (w.apiKey === apiKey) {
                targetWorker = w;
                break;
            }
        }

        if (!targetWorker) {
            return res.status(404).json({
                error: 'No online worker found',
                tip: 'Đảm bảo đã bật Remote API trong Side Panel và API Key giống hệt'
            });
        }

        const jobId = uuidv4();

        jobs.set(jobId, {
            jobId,
            items: items || [],
            mode,
            webhookUrl: webhookUrl || '',
            promptLanguage,
            targetSite,
            status: 'processing',
            createdAt: new Date(),
            workerId: targetWorker.workerId
        });

        targetWorker.socket.emit('RUN_BULK_PROMPT', {
            jobId,
            items,
            webhookUrl,
            mode,
            promptLanguage,
            targetSite
        });

        console.log(`✅ ĐÃ GỬI JOB ${jobId} đến worker ${targetWorker.workerId} | targetSite=${targetSite}`);

        res.json({
            success: true,
            jobId,
            message: 'Job đã được gửi thành công đến extension!'
        });
    });

    router.get('/jobs/:jobId', (req, res) => {
        const job = jobs.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
    });

    router.get('/workers', (req, res) => {
        const list = Array.from(workers.values()).map(w => ({
            workerId: w.workerId,
            apiKey: w.apiKey,
            name: w.name,
            onlineAt: w.onlineAt
        }));

        res.json({
            total: list.length,
            workers: list
        });
    });

    return router;
};