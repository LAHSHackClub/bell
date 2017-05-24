const _ = require('lodash');
const $ = require('jquery');
const async = require('async');

var self;

(function() {
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
  var numberToStringLength = function(number, length) {
    var numberString = number.toString();
    for (var i = numberString.length; i < length; i++)
      numberString = '0' + numberString;
    return numberString;
  };
  var dateToString = function(date) {
    return date.getFullYear().toString() + numberToStringLength(date.getMonth() + 1, 2) + numberToStringLength(date.getDate(), 2);
  };

  BellTimer.prototype.setDebugLogFunction = function(logger) {
    this.debug = logger;
  };
  BellTimer.prototype.getSchool = function() {
    return this.school;
  };
  BellTimer.prototype.reloadSchool = function(callback) {
    var school = window.location.hash.substring(1);
    school = (school) ? school : self.cookieManager.getJSONGuaranteed('school').link;
    if (!school) {
      window.location = '/chooser';
    } else {
      $.get('/api/school/' + school)
        .done(function(school) {
          if (!school)
            window.location = '/chooser';
          else
            self.cookieManager.set('school', school);
        })
        .always(function() {
          var school = self.cookieManager.getJSON('school');
          self.school = school;
          callback(null, school);
        });
    }
  };
  var stringToTimeArray = function(str) {
    var index = str.indexOf(':');
    var hour = parseInt(str.substring(0, index));
    var minute = parseInt(str.substring(index + 1));
    return [hour, minute];
  };
  BellTimer.prototype.reloadData = function(callback) {
    var parseData = function(data) {
      self.schedules = data.schedules;
      self.calendar = data.calendar;

      if (callback)
        callback();
    };
    var parseSchedules = function(schedules) {
      var classes = self.classesManager.getClasses();

      for (var key in schedules) {
        var schedule = schedules[key];
        var periodArray = [];

        for (var time in schedule.periods) {
          var name = '';
          for (var i in schedule.periods[time]) {
            if (typeof schedule.periods[time][i] == 'string')
              name += schedule.periods[time][i];
            else
              name += classes[schedule.periods[time][i]];
          }
          periodArray.push({
            name: name,
            time: stringToTimeArray(time)
          });
        }

        schedule.periods = periodArray;
      }
      return schedules;
    };

    $.get('/api/version?v=' + Date.now())
      .done(function(version) {
        if (self.version && self.version != version)
          $(window)[0].location.reload();
        else
          self.version = version;
      });

    var getSchool = function(callback) {
      self.reloadSchool(callback);
    };
    var getSchedules = function(callback) {
      $.get('/api/schedules?v=' + Date.now() + '&s=' + self.getSchool().link)
        .done(function(schedules) {
          self.cookieManager.setLong('schedules', schedules);
        })
        .always(function() {
          var schedules = self.cookieManager.getLongJSON('schedules');
          schedules = parseSchedules(schedules);
          callback(null, schedules);
        });
    };
    var getCalendar = function(callback) {
      $.get('/api/calendar?v=' + Date.now() + '&s=' + self.getSchool().link)
        .done(function(calendar) {
          self.cookieManager.setLong('calendar', calendar);
        })
        .always(function() {
          var calendar = self.cookieManager.getLongJSON('calendar');
          callback(null, calendar);
        });
    };
    var getCorrection = function(callback) {
      $.get('/api/correction?v=' + Date.now() + '&s=' + self.getSchool().link)
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
    getSchool(function(err, school) {
      getCorrection(function(err, correction) {
        getSchedules(function(err, schedules) {
          getCalendar(function(err, calendar) {
            parseData({
              schedules: schedules,
              calendar: calendar
            }, callback);
          });
        });
      });
    });
  };
  BellTimer.prototype.initialize = function(callback) {
    async.series([
      self.reloadData,
      _.partial(self.initializeTimesync)
      //_.partial(self.synchronize, n)
    ], callback);
  };
  BellTimer.prototype.initializeTimesync = function(callback) {
    var callback = _.once(callback);

    if (typeof timesync == 'undefined') {
      self.ts = Date;
      return callback();
    }

    var ts = timesync.create({
      server: '/timesync',
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
  BellTimer.prototype.getCorrection = function() {
    return this.bellCompensation;
  };
  BellTimer.prototype.enableDevMode = function(startDate, scale) {
    this.devMode = true;
    this.startTime = startDate.getTime();
    this.devModeStartTime = Date.now();
    this.timeScale = scale;
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
  var numberToDayName = function(i) {
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[i];
  };
  var getSpecialSchedule = function(calendar, dateString) {
    var dateNumber = parseInt(dateString);
    var specialDays = calendar.special;
    for (var date in specialDays) {
      var split = date.split('-');
      var dateStartNumber = parseInt(split[0]);
      var dateEndNumber = parseInt(split[1] || split[0]);
      if (dateNumber >= dateStartNumber && dateNumber <= dateEndNumber)
        return specialDays[date];
    }
    return false;
  };
  BellTimer.prototype.getCurrentSchedule = function(date) {
    if (!date) date = self.getDate();
    var dateString = dateToString(date);
    var specialDay = getSpecialSchedule(self.calendar, dateString);

    var schedule;
    if (specialDay) {
      schedule = self.schedules[specialDay[0]];
      schedule.name = specialDay[1] || schedule.name;
    } else {
      schedule = self.schedules[self.calendar.default[numberToDayName(date.getDay())]];
    }

    for (var i in schedule.periods) {
      var timestamp = timeArrayToDate(date, schedule.periods[i].time, true);
      schedule.periods[i].timestamp = timestamp;
    }

    return schedule;
  };
  BellTimer.prototype.synchronize = function(n, callback) {
    var getTimeCorrection = function(callback) {
      var sentTime = Date.now();
      $.get('/api/time', function(data) {
        var serverTime = data.time;
        var currentTime = Date.now();

        var delay = Math.floor((currentTime - sentTime) / 2);
        var correctedTime = serverTime + delay;
        var correction = correctedTime - currentTime;

        callback(null, correction);
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