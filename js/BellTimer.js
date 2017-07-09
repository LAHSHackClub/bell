const _ = require('lodash');
const $ = require('jquery');
const async = require('async');

var self;

/**
 * Runs a bell timer. Note that the timesync library must have been imported from somewhere
 * else (since require('timesync') seems to complain). For the bell.lahs.club site, it can
 * be found at /timesync/timesync.js. For external applications, it can be found at
 * https://bell.lahs.club/timesync/timesync.js.
 * Note that for usage in Chrome extensions, the following line must be added to manifest.json:
 * "content_security_policy": "script-src 'self' https://bell.lahs.club; object-src 'self'",
 * to allow the use of external libraries.
 * Finally, the name of the host website can be changed as needed, provided that there is a
 * /timsync/timesync.js somewhere.
 */
(function() {
  /**
   * Creates a new instance of BellTimer, with a ClassesManager object. The ClassesManager is
   * necessary to store the current class period.
   * @param {ClassesManager} classesManager
   * @param {CookieManager} cookieManager
   */
  var BellTimer = function(classesManager, cookieManager) {
    self = this;

    this.classesManager = classesManager;
    this.cookieManager = cookieManager;

    this.debug = function() {};
    this.devMode = false;
    this.startTime = 0;
    this.timeScale = 1;
  };

  var timeArrayToDate = function(date, timeArray, resetMilliseconds) {
    var date = new Date(date.getTime());
    date.setHours(timeArray[0]);
    date.setMinutes(timeArray[1]);
    date.setSeconds(0);
    if (resetMilliseconds)
      date.setMilliseconds(0);
    return date;
  };
  var dateToString = function(date) {
    return date.getYear() + '-' + date.getMonth() + '-' + date.getDate();
  };

  BellTimer.prototype.setDebugLogFunction = function(logger) {
    this.debug = logger;
  };

  /**
   * Reloads schedule data from the host website.
   * @param {String} host The URI string giving the location of the api. For LAHS,
   * it should be "https://bell.lahs.club".
   * @param {Function} callback The callback to be executed. Can be undefined.
   */
  BellTimer.prototype.reloadDataFromHost = function(host, callback) {
    var parseData = function(data) {
      var rawSchedules = data.schedules;
      for (var key in rawSchedules) {
        var schedule = rawSchedules[key];
        for (var i = 0; i < schedule.periods.length; i++) {
          var period = schedule.periods[i];
          var nameSplit = period.name.split('{').map(function(a) {
            return a.split('}');
          }).reduce(function(a, b) {
            return a.concat(b);
          });
          for (var j = 1; j < nameSplit.length; j += 2) {
            nameSplit[j] = self.classesManager.getClasses()[parseInt(nameSplit[j])];
          }
          var name = nameSplit.reduce(function(a, b) {
            return a.concat(b);
          });
          period.name = name;
          if (name == 'Passing to Free') {
            period.name = 'Free';
          } else if (name == 'Free') {
            schedule.periods.splice(i, 1);
            i--;
          }
          if (i == 0 && name == 'Free') {
            schedule.periods.splice(i, 1);
            i--;
          }
        }
      };

      self.schedules = rawSchedules;
      self.calendar = data.calendar;

      if (callback)
        callback();
    };
    var parseSchedules = function(text) {
      var outputSchedules = {};

      var lines = text.split('\n');

      var currentScheduleName;
      var currentSchedule;
      for (var i in lines) {
        var line = lines[i];
        if (line[0] == '*') {
          if (currentSchedule)
            outputSchedules[currentScheduleName] = currentSchedule;
          currentScheduleName = line.substring(2).split(' (')[0];
          currentSchedule = {
            displayName: line.split('(')[1].substring(0, line.split('(')[1].indexOf(')')),
            periods: []
          };
          if (line.indexOf('[') > -1)
            currentSchedule.color = line.split('[')[1].substring(0, line.split('[')[1].indexOf(']'));
        } else {
          if (!line)
            continue;
          var time = line.substring(0, line.indexOf(' '));
          var hour = time.split(':')[0];
          var minute = time.split(':')[1];
          var periodName = line.substring(line.indexOf(' ') + 1);

          currentSchedule.periods.push({
            name: periodName,
            time: [parseInt(hour), parseInt(minute)]
          });
        }
      }

      if (currentSchedule) {
        outputSchedules[currentScheduleName] = currentSchedule;
      }

      return outputSchedules;
    };
    var parseCalendar = function(text, schedules) {
      var calendar = {
        defaultWeek: [],
        specialDays: {}
      };

      var lines = text.split('\n');

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line == '* Default Week') {
          line = lines[++i];
          while (line && line[0] != '*') {
            calendar.defaultWeek.push(line.substring(2));
            line = lines[++i];
          }
        }
        if (line == '* Special Days') {
          line = lines[++i];

          while (line && line[0] != '*') {
            if (line.split(' ')[0].indexOf('-') > -1) {
              // is a range
              var date = new Date(line.split(' ')[0].split('-')[0]);
              var endDate = new Date(line.split(' ')[0].split('-')[1]);
              var scheduleName = line.split(' ')[1];
              var schedule = {
                scheduleName: scheduleName,
                customName: (line.indexOf('(') > -1) ? line.split('(')[1].substring(0, line.split('(')[1].indexOf(')')) : schedules[scheduleName].displayName
              };
              while (dateToString(date) != dateToString(endDate)) {
                calendar.specialDays[dateToString(date)] = schedule;
                date.setDate(date.getDate() + 1);
              }
              calendar.specialDays[dateToString(endDate)] = schedule;
            } else {
              // is not a range
              var date = new Date(line.split(' ')[0]);
              var scheduleName = line.split(' ')[1];
              calendar.specialDays[dateToString(date)] = {
                scheduleName: scheduleName,
                customName: (line.indexOf('(') > -1) ? line.split('(')[1].substring(0, line.split('(')[1].indexOf(')')) : schedules[scheduleName].displayName
              };
            }
            line = lines[++i];
          }
        }
      }

      return calendar;
    };

    $.get(host + '/api/version?v=' + Date.now())
      .done(function(version) {
        if (self.version && self.version != version)
          $(window)[0].location.reload();
        else
          self.version = version;
      })
      .fail(function() {
        console.log("Request to", host, "/api/version failed.");
        self.version = 0;
      });

    var getSchedules = function(callback) {
      $.get(host + '/api/schedules?v=' + Date.now())
        .done(function(schedules) {
          self.cookieManager.setLong('schedules', schedules);
          var schedules = parseSchedules(schedules);
          callback(null, schedules);
        })
        .fail(function() {
          console.log("Request to", host, "/api/schedules failed. Attempting to retrieve schedule from cookies.");
          var schedules = parseSchedules(self.cookieManager.getLong('schedules'));
          callback(null, schedules);
        });
    };
    var getCalendar = function(schedules, callback) {
      $.get(host + '/api/calendar?v=' + Date.now())
        .done(function(calendar) {
          self.cookieManager.setLong('calendar', calendar);
          var calendar = parseCalendar(calendar, schedules);
          callback(null, calendar)
        })
        .fail(function() {
          var calendar = parseCalendar(self.cookieManager.getLong('calendar'), schedules);
          console.log("Request to", host, "/api/calendar failed. Attempting to retrieve calendar from cookies.");
          callback(null, calendar);
        });
    };
    var getCorrection = function(callback) {
      $.get(host + '/api/correction?v=' + Date.now())
        .done(function(correction) {
          correction = parseInt(correction);
          self.bellCompensation = correction;
          callback(null, correction);
        })
        .fail(function() {
          self.bellCompensation = 0;
          callback(null, 0);
        });
    };
    getCorrection(function(err, correction) {
      getSchedules(function(err, schedules) {
        getCalendar(schedules, function(err, calendar) {
          parseData({
            schedules: schedules,
            calendar: calendar
          }, callback);
        });
      });
    });
  };
  BellTimer.prototype.reloadData = function(callback) {
    self.reloadDataFromHost("", callback);
  }; //_.partial(self.reloadDataFromHost, "");
  BellTimer.prototype.initializeFromHost = function(host, callback) {
    async.series([
      _.partial(self.initializeTimesyncFromHost, host),
      _.partial(self.reloadDataFromHost, host)
    ], callback);
  };
  BellTimer.prototype.initialize = function(callback) {
    async.series([
      self.reloadData,
      _.partial(self.initializeTimesync)
      //_.partial(self.synchronize, n)
    ], callback);
  };
  BellTimer.prototype.initiailizeTimesync = function(callback) {
    self.initializeTimesyncFromHost("", callback);
  };
  BellTimer.prototype.initializeTimesyncFromHost = function(host, callback) {
    var callback = _.once(callback);
    if (typeof timesync == 'undefined') {
      self.ts = Date;
      return callback();
    }
    var ts = timesync.create({
      server: (host + '/timesync'),
      interval: 4 * 60 * 1000
    });

    ts.on('change', function(offset) {
      self.debug('Timesync offset: ' + offset);
    });

    ts.on('sync', _.once(function() {
      callback();
    }));
    self.ts = ts;
  };
  BellTimer.prototype.setCorrection = function(correction) {
    this.bellCompensation = correction;
  };
  /**
   * Returns the difference between the timesync server's time and the school's bell time.
   * Note that this does not give the difference between timesync.now() and Date.now(), as
   * that is handled by the server.
   */
  BellTimer.prototype.getCorrection = function() {
    return this.bellCompensation;
  };
  BellTimer.prototype.enableDevMode = function(startDate, scale) {
    this.devMode = true;
    this.startTime = startDate.getTime();
    this.devModeStartTime = Date.now();
    this.timeScale = scale;
    console.log("Dev mode enabled, with startDate=", startDate, "scale=", scale);
  }
  BellTimer.prototype.getDate = function() {
    if (this.devMode)
      return new Date(this.startTime + ((Date.now() - this.devModeStartTime) * this.timeScale));

    return new Date(this.ts.now() + this.bellCompensation);
    // return new Date(Date.now() + this.bellCompensation + this.synchronizationCorrection);
  };
  BellTimer.prototype.getTimeRemainingNumber = function() {
    var date = this.getDate();
    if (!this.getNextPeriod().timestamp.getTime)
      console.log(this.getNextPeriod());
    return this.getNextPeriod().timestamp.getTime() - (Math.floor(date.getTime() / 1000) * 1000);
  };
  /**
   * Returns the time remaining in this period as a String of form hh:mm:ss.
   * @return the string specified above.
   */
  BellTimer.prototype.getTimeRemainingString = function() {
    var date = this.getDate();
    var displayTimeNumber = function(time) {
      var hours = Math.floor(time / 1000 / 60 / 60);
      var seconds = Math.floor(time / 1000 % 60).toString();
      if (seconds.length < 2)
        seconds = '0' + seconds;
      var minutes = Math.floor(time / 1000 / 60 % 60).toString();
      if (minutes.length < 2 && hours)
        minutes = '0' + minutes;
      return (hours < 1) ? minutes + ':' + seconds : hours + ':' + minutes + ':' + seconds;
    };
    return displayTimeNumber(this.getTimeRemainingNumber());
  };
  BellTimer.prototype.getWaitUntilNextTick = function() {
    return this.getDate().getMilliseconds();
  };
  BellTimer.prototype.getProportionElapsed = function() {
    var date = this.getDate();

    var currentPeriodStart = this.getCurrentPeriod().timestamp.getTime();
    var nextPeriodStart = this.getNextPeriod().timestamp.getTime();

    var totalTime = nextPeriodStart - currentPeriodStart;
    var elapsedTime = date.getTime() - currentPeriodStart;

    return elapsedTime / totalTime;
  };
  BellTimer.prototype.getNextPeriod = function() {
    var date = this.getDate();
    return this.getPeriodByNumber(date, this.getCurrentPeriodNumber(date) + 1);
  };
  BellTimer.prototype.getCurrentPeriod = function() {
    var date = this.getDate();
    return this.getPeriodByNumber(date, this.getCurrentPeriodNumber(date));
  };
  BellTimer.prototype.getPeriodByNumber = function(date, i) {
    var currentPeriods = this.getCurrentSchedule(date).periods;
    if (i == -1) {
      return {
        name: 'None',
        time: this.getPreviousPeriod().time,
        timestamp: this.getPreviousPeriod().timestamp
      };
    }
    if (i == currentPeriods.length) {
      var newDate = new Date(date.getTime());
      newDate.setSeconds(0);
      newDate.setMinutes(0);
      newDate.setHours(0);
      newDate.setDate(newDate.getDate() + 1);
      var period = _.cloneDeep(this.getPeriodByNumber(newDate, 0));

      return period;
    }
    return currentPeriods[i];
  };
  BellTimer.prototype.getCurrentPeriodNumber = function() {
    var date = this.getDate();
    var schedule = this.getCurrentSchedule(date);
    var periods = schedule.periods;
    for (var i = 0; i < periods.length; i++) {
      if (periods[i].time[0] > date.getHours())
        return i - 1;
      if (periods[i].time[0] == date.getHours())
        if (periods[i].time[1] > date.getMinutes())
          return i - 1;
    }
    return i - 1;
  };
  BellTimer.prototype.getCompletedPeriods = function() {
    var completedPeriods = [];
    var schedule = this.getCurrentSchedule();
    var periods = schedule.periods;
    for (var i = 0; i < this.getCurrentPeriodNumber(); i++) {
      completedPeriods.push(periods[i]);
    }
    return completedPeriods;
  };
  BellTimer.prototype.getFuturePeriods = function() {
    var futurePeriods = [];
    var schedule = this.getCurrentSchedule();
    var periods = schedule.periods;
    for (var i = this.getCurrentPeriodNumber() + 1; i < periods.length; i++) {
      futurePeriods.push(periods[i]);
    }
    return futurePeriods;
  };
  BellTimer.prototype.getPreviousPeriod = function(date) {
    var completedPeriods = this.getCompletedPeriods();
    if (this.getCompletedPeriods().length > 0)
      return _.last(this.getCompletedPeriods());

    if (!date) date = self.getDate();
    var date = new Date(date.getTime());
    date.setDate(date.getDate() - 1);

    var schedule = this.getCurrentSchedule(date);
    if (schedule.periods.length > 0)
      return _.last(schedule.periods);
    else
      return this.getPreviousPeriod(date);
  };
  BellTimer.prototype.getCurrentSchedule = function(date) {
    if (!date) date = self.getDate();
    var dateString = dateToString(date);
    var specialDay = self.calendar.specialDays[dateString];

    var schedule;
    if (specialDay) {
      schedule = self.schedules[specialDay.scheduleName];
      schedule.displayName = specialDay.customName;
    } else {
      schedule = self.schedules[self.calendar.defaultWeek[date.getDay()]];
    }

    for (var i in schedule.periods) {
      var timestamp = timeArrayToDate(date, schedule.periods[i].time, true);
      schedule.periods[i].timestamp = timestamp;
    }

    return schedule;
  };
  BellTimer.prototype.synchronize = function(n, callback) {
    synchronizeFromHost("", n, callback);
  }
  BellTimer.prototype.synchronizeFromHost = function(host, n, callback) {
    var getTimeCorrection = function(callback) {
      var sentTime = Date.now();
      $.get(host + '/api/time', function(data) {
        var serverTime = data.time;
        var currentTime = Date.now();

        var delay = Math.floor((currentTime - sentTime) / 2);
        var correctedTime = serverTime + delay;
        var correction = correctedTime - currentTime;

        callback(null, correction);
      })
      .fail(function() {
        console.log("Request to", host, "/api/time failed.");
        callback(null, 0);
      });
    };

    var synchronize = function(n, callback) {
      var sum = function(nums) {
        return nums.reduce(function(x, y) {
          return x + y;
        });
      };
      var avg = function(nums) {
        return sum(nums) / nums.length;
      };
      var med = function(nums) {
        return nums.sort()[Math.floor(nums.length / 2)];
      };
      var stdev = function(nums) {
        var mean = avg(nums);
        return Math.sqrt(sum(nums.map(function(x) {
          return (x - mean) * (x - mean);
        })) / nums.length);
      };
      var removeOutliers = function(nums) {
        var nums = _.cloneDeep(nums);
        var standardDeviation = stdev(nums);
        var median = med(nums);
        for (var i = 0; i < nums.length; i++) {
          if (Math.abs(nums[i] - median) > standardDeviation) {
            nums.splice(i, 1);
            i--;
          }
        }
        return nums;
      };

      var startTime = Date.now();
      async.timesSeries(n, function(n, callback) {
        _.delay(getTimeCorrection, 10, callback);
      }, function(err, allCorrections) {

        self.debug('Synchronization corrections: ' + allCorrections);
        var correction = _.flow([removeOutliers, avg, _.floor])(allCorrections);
        self.debug('Correction: ' + correction);
        self.debug('Took ' + (Date.now() - startTime) + ' ms to synchronize');

        self.synchronizationCorrection = correction;

        callback(err, correction);
      });
    };

    synchronize(n, callback);
  };

  module.exports = BellTimer;
  //window.BellTimer = BellTimer;
})();