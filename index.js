const config = require('./config.json');
const logger = require('loggy');
const http = require('http');
const express = require('express');
const app = express();
const server = http.createServer(app);
const fs = require('fs-extra');
const shortid = require('shortid');
const async = require('async');
const redis = require('redis');
const _ = require('lodash');
const Sniffr = require('sniffr');
const crypto = require('crypto');
var client; // redis client
const timesyncServer = require('timesync/server');

var schools = [{
  name: 'Los Altos High School',
  user: 'user1',
  rating: 99,
  link: 'lahs'
}, {
  name: 'Mountain View High School',
  user: 'user2',
  rating: 99,
  link: 'mvhs'
}, {
  name: 'Gunn High School',
  user: 'user3',
  rating: 99,
  link: 'gunn'
}];
var searchSchools = function(query) {
  query = query.toLowerCase();
  var results = [];
  for (var i = 0; i < schools.length; i++) {
    var schoolString = schools[i].name + ' #' + schools[i].link + ' ' + schools[i].user;
    schoolString = schoolString.toLowerCase();
    if (schoolString.indexOf(query) > -1)
      results.push(schools[i]);
  }
  return results;
};
var lookupSchoolByLink = function(link) {
  for (var i = 0; i < schools.length; i++)
    if (schools[i].link == link)
      return schools[i];
  return null;
};
var connectToRedis = function(callback) {
  if (!config['enable redis']) {
    logger.warn('Redis disabled');
    return callback();
  }
  client = (config['redis password']) ? redis.createClient({
    host: config['redis host'],
    password: config['redis password']
  }) : redis.createClient();

  client.on('ready', function() {
    logger.success('Redis connected');
    callback();
  });
  client.on('error', function(err) {
    logger.error(err);
  });
};
var startWebServer = function(callback) {
  var previousCheck = 0;
  var currentVersion;
  var getVersion = function() {
    if (Date.now() - previousCheck < 1000 * 60 && currentVersion) return currentVersion;

    previousCheck = Date.now();
    var hash = crypto.createHash('md5');
    currentVersion = hash.update(fs.readFileSync('data/version.txt').toString()).digest('hex');
    return currentVersion;
  };

  var ensureDirectory = function(link) {
    fs.ensureDirSync(`data/${link}`);
    if (!fs.existsSync(`data/${link}/correction.txt`))
      fs.copySync('data_default/correction.txt', `data/${link}/correction.txt`);
    if (!fs.existsSync(`data/${link}/schedules.json`))
      fs.copySync('data_default/schedules.json', `data/${link}/schedules.json`);
    if (!fs.existsSync(`data/${link}/calendar.json`))
      fs.copySync('data_default/calendar.json', `data/${link}/calendar.json`);
  };
  var getCorrection = function(link) {
    ensureDirectory(link);
    return _.parseInt(fs.readFileSync(`data/${link}/correction.txt`).toString());
  };
  var getSchedules = function(link) {
    ensureDirectory(link);
    return JSON.parse(fs.readFileSync(`data/${link}/schedules.json`).toString());
  };
  var getCalendar = function(link) {
    ensureDirectory(link);
    return JSON.parse(fs.readFileSync(`data/${link}/calendar.json`).toString());
  };

  app.get('/', (req, res) => {
    res.render('index', {
      version: getVersion(),
      server_name: config['server name']
    });
  });
  app.get('/chooser', (req, res) => {
    res.render('chooser');
  });
  app.get('/search', (req, res) => {
    res.render('search', {
      query: req.query.q,
      results: searchSchools(req.query.q)
    });
  });

  //if (config['enable redis'])
  app.get('/stats', (req, res) => {
    res.render('stats', {
      version: getVersion()
    });
  })
  if (config['enable redis'])
    app.get('/api/stats', (req, res) => {
      var out = {};
      async.parallel([
        function(callback) {
          out.dailyStats = {};
          client.hgetall('dates', (err, dates) => {
            async.forEachOf(dates, (id, date, callback) => {
              client.get(`totalDailyHits:${id}`, (err, totalHits) => {
                client.scard(`deviceConnections:${id}`, (err, devices) => {
                  out.dailyStats[date] = {
                    totalHits: parseInt(totalHits),
                    devices: devices
                  };
                  callback(null);
                });
              });
            }, callback);
          });
        },
        function(callback) {
          out.userStats = {
            browser: {},
            os: {},
            theme: {}
          };
          client.hgetall('users', (err, users) => {
            async.forEachOf(users, (id, user, callback) => {
              client.hgetall(`users:${id}`, (err, data) => {
                if (!data)
                  return callback();
                if (!out.userStats.browser[data.browser])
                  out.userStats.browser[data.browser] = 0;
                out.userStats.browser[data.browser]++;
                if (!out.userStats.os[data.os])
                  out.userStats.os[data.os] = 0;
                out.userStats.os[data.os]++;
                if (!out.userStats.theme[data.theme])
                  out.userStats.theme[data.theme] = 0;
                out.userStats.theme[data.theme]++;
                callback();
              });
            }, callback);
          });
        }
      ], function(err) {
        res.json(out);
      });
    });
  app.get('/api/correction', (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.send(getCorrection(req.query.s).toString());
  });
  app.get('/api/calendar', (req, res) => {
    res.json(getCalendar(req.query.s));
  });
  app.get('/api/schedules', (req, res) => {
    res.json(getSchedules(req.query.s));
  });
  app.get('/api/version', (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.send(getVersion());
  });
  app.get('/api/uuid', (req, res) => {
    res.set('Content-Type', 'text/json');
    res.send({
      id: shortid.generate()
    });
  });
  app.get('/api/time', (req, res) => {
    res.json({
      time: Date.now()
    });
  });
  app.get('/api/school/:link', (req, res) => {
    res.json(lookupSchoolByLink(req.params.link));
  });

  var bodyParser = require('body-parser')
  app.use(bodyParser.json()); // to support JSON-encoded bodies
  app.use(bodyParser.urlencoded({ // to support URL-encoded bodies
    extended: true
  }));
  app.set('view engine', 'pug');
  app.use('/timesync', timesyncServer.requestHandler);

  app.post('/api/analytics', (req, res) => {
    if (!config['enable redis'])
      return res.json({
        success: false
      });
    var dateString = new Date().toLocaleDateString();
    //var dateString = '' + date.getFullYear() + date.getMonth() + date.getDate();
    var ensureDateId = function(callback) {
      client.hget('dates', dateString, (err, res) => {
        if (!res) {
          client.incr('date_id', (err, id) => {
            client.hset('dates', dateString, id);
            callback(id);
          });
        } else {
          callback(res);
        }
      });
    };
    var addId = function(id) {
      if (req.body.newPageLoad != 'true')
        return;

      //var now = Date.now();
      client.sismember(`deviceConnections:${id}`, req.body.id, (err, res) => {
        if (!res) {
          client.sadd(`deviceConnections:${id}`, req.body.id);
          //client.rpush(`deviceConnectionsTimes:${id}`, now);
        }
      });

      client.incr(`totalDailyHits:${id}`);
      //client.rpush(`totalHitsTimes:${id}`, now);
    };
    ensureDateId(addId);


    var ensureUserId = function(callback) {
      client.hget('users', req.body.id, (err, res) => {
        if (!res) {
          client.incr('user_id', (err, id) => {
            client.hset('users', req.body.id, id);
            callback(null, id);
          });
        } else {
          callback(null, res);
        }
      });
    };
    var updateUserInfo = function(id, callback) {
      var s = new Sniffr();
      s.sniff(req.body.userAgent)
      client.hmset(`users:${id}`, 'userAgent', req.body.userAgent, 'browser', s.browser.name, 'os', s.os.name, 'theme', req.body.theme, 'last seen', Date.now(), callback);
    };
    ensureUserId(function(err, id) {
      updateUserInfo(id);
    });

    res.json({
      success: true
    });
  });
  app.get('/api/themes', (req, res) => {
    res.set('Content-Type', 'text/json');
    res.sendFile(__dirname + '/data/themes.json');
  });

  app.use('/favicons', express.static('favicons'));
  app.use('/js', express.static('js'));
  app.use('/css', express.static('css'));

  server.listen(config.port, function() {
    logger.success('Web server listening on *:' + config.port);
    callback();
  });
};

async.parallel([
  connectToRedis,
  startWebServer
], function(err) {
  logger.success('Ready!');
});