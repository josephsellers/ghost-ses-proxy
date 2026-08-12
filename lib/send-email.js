var Busboy = require('busboy');
var { v4: uuidv4 } = require('uuid');
var config = require('./config');
var { insertMessageMap, insertRecipientEmail, tryClaimRecipient } = require('./db');
var { sendRawEmail } = require('./ses-client');
var substituteVars = require('./template-vars');
var crypto = require('crypto');

// Simple promise-based semaphore for concurrency limiting
function Semaphore(max) {
  this.max = max;
  this.current = 0;
  this.queue = [];
}

Semaphore.prototype.acquire = function() {
  var self = this;
  if (self.current < self.max) {
    self.current++;
    return Promise.resolve();
  }
  return new Promise(function(resolve) {
    self.queue.push(resolve);
  });
};

Semaphore.prototype.release = function() {
  this.current--;
  if (this.queue.length > 0) {
    this.current++;
    var next = this.queue.shift();
    next();
  }
};

var semaphore = new Semaphore(config.sendConcurrency);

function generateBoundary() {
  return '----=_Part_' + crypto.randomBytes(16).toString('hex');
}

function buildRawMime(opts) {
  var boundary = generateBoundary();
  var lines = [];

  lines.push('From: ' + opts.from);
  lines.push('To: ' + opts.to);
  lines.push('Subject: ' + opts.subject);

  if (opts.replyTo) {
    lines.push('Reply-To: ' + opts.replyTo);
  }
  if (opts.sender) {
    lines.push('Sender: ' + opts.sender);
  }
  if (opts.messageId) {
    lines.push('Message-ID: ' + opts.messageId);
  }
  if (opts.listUnsubscribe) {
    lines.push('List-Unsubscribe: ' + opts.listUnsubscribe);
  }
  if (opts.listUnsubscribePost) {
    lines.push('List-Unsubscribe-Post: ' + opts.listUnsubscribePost);
  }

  // Custom headers (h:* fields from Ghost)
  if (opts.customHeaders) {
    var keys = Object.keys(opts.customHeaders);
    for (var i = 0; i < keys.length; i++) {
      lines.push(keys[i] + ': ' + opts.customHeaders[keys[i]]);
    }
  }

  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  lines.push('');

  // text/plain part
  if (opts.text) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(opts.text).toString('base64'));
    lines.push('');
  }

  // text/html part
  if (opts.html) {
    lines.push('--' + boundary);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(opts.html).toString('base64'));
    lines.push('');
  }

  lines.push('--' + boundary + '--');
  lines.push('');

  return lines.join('\r\n');
}

function parseFormData(req) {
  return new Promise(function(resolve, reject) {
    var fields = {};
    var arrayFields = {}; // Fields that should accumulate as arrays

    var busboy;
    try {
      busboy = Busboy({ headers: req.headers });
    } catch (e) {
      return reject(new Error('Invalid multipart form-data: ' + e.message));
    }

    busboy.on('field', function(name, value) {
      // These fields can appear multiple times — accumulate as arrays
      if (name === 'to' || name === 'o:tag') {
        if (!arrayFields[name]) arrayFields[name] = [];
        arrayFields[name].push(value);
      } else {
        fields[name] = value;
      }
    });

    busboy.on('finish', function() {
      // Merge array fields into fields
      var keys = Object.keys(arrayFields);
      for (var i = 0; i < keys.length; i++) {
        fields[keys[i]] = arrayFields[keys[i]];
      }
      resolve(fields);
    });

    busboy.on('error', function(err) {
      reject(err);
    });

    req.pipe(busboy);
  });
}

/**
 * Deliver one batch in the background after Ghost has already been ACKed.
 * Real Mailgun is async; Ghost's client has a 60s timeout, and waiting for
 * ~1000 SES SendRawEmail calls caused Ghost to retry mid-send (2–3× digests).
 */
function processBatch(opts) {
  var from = opts.from;
  var subject = opts.subject;
  var html = opts.html;
  var text = opts.text;
  var toList = opts.toList;
  var tags = opts.tags;
  var emailId = opts.emailId;
  var batchId = opts.batchId;
  var batchMessageId = opts.batchMessageId;
  var recipientVars = opts.recipientVars;
  var customHeaders = opts.customHeaders;
  var replyTo = opts.replyTo;
  var sender = opts.sender;
  var fields = opts.fields;
  var tagsJson = JSON.stringify(tags);

  var succeeded = 0;
  var failed = 0;
  var skipped = 0;
  var start = Date.now();

  var promises = toList.map(function(recipient) {
    return semaphore.acquire().then(function() {
      // Idempotency: only the first claim for (ghost_email_id, recipient) sends.
      // Ghost retries that race with an in-flight batch (or arrive after ACK loss)
      // are no-ops instead of second SES deliveries.
      if (!tryClaimRecipient(emailId, recipient, batchMessageId)) {
        skipped++;
        semaphore.release();
        if (config.logLevel === 'debug') {
          console.log('Skip duplicate: ' + recipient + ' already claimed for email ' + emailId);
        }
        return;
      }

      var vars = recipientVars[recipient] || {};

      // Substitute template variables
      var recipientHtml = substituteVars(html, vars);
      var recipientText = substituteVars(text, vars);

      // Process List-Unsubscribe header
      var listUnsubscribe = fields['h:List-Unsubscribe'] || '';
      if (listUnsubscribe) {
        listUnsubscribe = substituteVars(listUnsubscribe, vars);
        // Strip Mailgun-specific <%tag_unsubscribe_email%> placeholder
        listUnsubscribe = listUnsubscribe.replace(/,?\s*<%tag_unsubscribe_email%>/g, '');
        // Clean up trailing/leading commas and whitespace
        listUnsubscribe = listUnsubscribe.replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
      }

      var listUnsubscribePost = fields['h:List-Unsubscribe-Post'] || '';

      // Build raw MIME message
      var rawMessage = buildRawMime({
        from: from,
        to: recipient,
        subject: subject,
        html: recipientHtml,
        text: recipientText,
        replyTo: replyTo,
        sender: sender,
        messageId: batchMessageId,
        listUnsubscribe: listUnsubscribe || undefined,
        listUnsubscribePost: listUnsubscribePost || undefined,
        customHeaders: customHeaders
      });

      return sendRawEmail(rawMessage, config.sesConfigurationSet).then(function(result) {
        // Store SES message ID -> batch mapping
        insertRecipientEmail.run(
          result.messageId,
          batchMessageId,
          recipient,
          emailId,
          tagsJson
        );
        succeeded++;
        if (config.logLevel === 'debug') {
          console.log('Sent to ' + recipient + ' (SES ID: ' + result.messageId + ')');
        }
      }).catch(function(err) {
        failed++;
        console.error('Failed to send to ' + recipient + ': ' + err.message);
      }).finally(function() {
        semaphore.release();
      });
    });
  });

  return Promise.all(promises).then(function() {
    var ms = Date.now() - start;
    if (failed > 0 && succeeded === 0 && skipped === 0) {
      console.error(
        'Batch ' + batchId + ' failed entirely: ' + failed + ' failures (' + ms + 'ms)'
      );
    } else {
      console.log(
        'Batch ' + batchId +
        ' done: sent=' + succeeded +
        ' skipped=' + skipped +
        ' failed=' + failed +
        ' total=' + toList.length +
        ' (' + ms + 'ms)'
      );
    }
  }).catch(function(err) {
    console.error('Batch ' + batchId + ' processing error:', err.message);
  });
}

function handleSendEmail(req, res) {
  parseFormData(req).then(function(fields) {
    var from = fields.from;
    var subject = fields.subject;
    var html = fields.html || '';
    var text = fields.text || '';
    var recipientVarsStr = fields['recipient-variables'];
    var toList = fields.to || [];
    var tags = fields['o:tag'] || [];
    var emailId = fields['v:email-id'] || '';
    var domain = req.params.domain || config.mailgunDomain;

    // Ensure toList is an array
    if (!Array.isArray(toList)) toList = [toList];
    if (!Array.isArray(tags)) tags = [tags];

    if (!from || !subject || toList.length === 0) {
      return res.status(400).json({ message: 'Missing required fields: from, subject, to' });
    }

    // Parse recipient variables
    var recipientVars = {};
    if (recipientVarsStr) {
      try {
        recipientVars = JSON.parse(recipientVarsStr);
      } catch (e) {
        return res.status(400).json({ message: 'Invalid recipient-variables JSON' });
      }
    }

    // Generate batch message ID
    var batchId = uuidv4() + '@' + domain;
    var batchMessageId = '<' + batchId + '>';

    // Store batch in message_map
    insertMessageMap.run(batchMessageId, emailId, JSON.stringify(tags));

    // Extract headers from h:* fields
    var customHeaders = {};
    var fieldKeys = Object.keys(fields);
    for (var i = 0; i < fieldKeys.length; i++) {
      var key = fieldKeys[i];
      if (key.startsWith('h:') && key !== 'h:Reply-To' && key !== 'h:Sender' && key !== 'h:List-Unsubscribe' && key !== 'h:List-Unsubscribe-Post') {
        customHeaders[key.slice(2)] = fields[key];
      }
    }

    // Always add X-Ghost-Email-Id for fallback correlation
    if (emailId) {
      customHeaders['X-Ghost-Email-Id'] = emailId;
    }

    var replyTo = fields['h:Reply-To'] || '';
    var sender = fields['h:Sender'] || '';

    // Mailgun returns immediately ("Queued. Thank you.") and sends async.
    // Ghost's mailgun.js client times out at 60s — holding the response until
    // every SES send finished made Ghost retry batches mid-flight.
    res.json({
      id: batchMessageId,
      message: 'Queued. Thank you.'
    });

    console.log(
      'Accepted batch ' + batchId +
      ' email_id=' + (emailId || '(none)') +
      ' recipients=' + toList.length
    );

    // Fire-and-forget background delivery
    processBatch({
      from: from,
      subject: subject,
      html: html,
      text: text,
      toList: toList,
      tags: tags,
      emailId: emailId,
      batchId: batchId,
      batchMessageId: batchMessageId,
      recipientVars: recipientVars,
      customHeaders: customHeaders,
      replyTo: replyTo,
      sender: sender,
      fields: fields
    });
  }).catch(function(err) {
    console.error('Send email error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error: ' + err.message });
    }
  });
}

module.exports = handleSendEmail;
