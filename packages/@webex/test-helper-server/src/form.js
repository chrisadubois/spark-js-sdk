/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */


const bodyParser = require(`body-parser`);
const express = require(`express`);
const reflect = require(`./reflect`);

/* eslint new-cap: [0] */
const router = express.Router();

// Configure Image processing
// -------------------------

router.use(bodyParser.urlencoded({extended: true}));

router.patch(`/reflect`, reflect);
router.put(`/reflect`, reflect);
router.post(`/reflect`, reflect);

module.exports = router;
