function ActivityMonitor() {
	this.sampleSize = 1024;
	this.analyzer = null;
	this.eventSubject = null;
	this.isRecording = false;
	this.audioCtx = null;

	this.volumeVis = VolumeVisualization({
						"id": "volume_visualization",
						"sampleSize": this.sampleSize
					});

	this.historyVis = new HistoryVisualization();
}

ActivityMonitor.NOT_BARKING = "NOT_BARKING";
ActivityMonitor.BARKING = "BARKING";
ActivityMonitor.BARKING_TIMEOUT_MS = 30000;

function EventState(opts) {
	if (typeof opts === 'undefined') {
		opts = {};
	}

	this.timestamp = opts.timestamp || Date.now();
	this.lastBark = opts.lastBark || 0;
	this.barkDetected = opts.barkDetected || false;
	this.volume = opts.volume || 0;
	this.mode = opts.mode || ActivityMonitor.NOT_BARKING;
	this.prevMode = opts.prevMode || ActivityMonitor.NOT_BARKING;
}

ActivityMonitor.prototype.startListening = function() {
	var self = this;

	self.historyVis.resume();

	if (self.audioCtx !== null) {
		if (self.audioCtx.state === "suspended") {
			self.audioCtx.resume();
			return;
		}
	}

	navigator.getUserMedia = (navigator.getUserMedia ||
                        navigator.webkitGetUserMedia ||
                        navigator.mozGetUserMedia ||
                        navigator.msGetUserMedia);

  navigator.getUserMedia({audio:true}, function(stream) {

	  self.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	  var source   = self.audioCtx.createMediaStreamSource(stream);
	  var analyzer = self.audioCtx.createAnalyser();
	  var samples  = new Uint8Array(self.sampleSize);

	  analyzer.fftSize = self.sampleSize;
	  analyzer.minDecibels = -55;
	  analyzer.maxDecibels = -10;
	  source.connect(analyzer);

		self.onAnalyzerReady(analyzer);

  }, function(err) {throw Error("Error: " + err)});

}

ActivityMonitor.prototype.stopListening = function() {
	this.historyVis.suspend();
	if (this.audioCtx && this.audioCtx.state === "running") {
		this.audioCtx.suspend();
	}
}

ActivityMonitor.prototype.recordState = function(state) {
	var tpl = $("#event-row-tpl");
	var newRow = tpl.clone();
	newRow.removeClass("hide");
	newRow.find(".timestamp").text(new Date(state.timestamp));
	newRow.find(".description").text(state.mode === ActivityMonitor.BARKING ? "Started Barking" : "Stopped Barking");
	newRow.find(".level").text(state.volume.toFixed(2));
	tpl.parent().append(newRow);
}

ActivityMonitor.prototype.determineNewState = function(oldState, volume) {
	var self = this;

	var timestamp = Date.now();
	var newState = new EventState(oldState);

	newState.timestamp = timestamp;
	newState.barkDetected = volume > 0.8;
	newState.lastBark = newState.barkDetected ? timestamp : oldState.lastBark;
	newState.prevMode = oldState.mode;
	newState.volume = volume;

	if (oldState.mode === ActivityMonitor.NOT_BARKING) {
		if (newState.barkDetected) {
			newState.mode = ActivityMonitor.BARKING;
		}
	} else {
		if (!newState.barkDetected && oldState.lastBark < timestamp - ActivityMonitor.BARKING_TIMEOUT_MS) {
			newState.mode = ActivityMonitor.NOT_BARKING;
		}
	}

	return newState;

};

ActivityMonitor.prototype.pollAudio = function() {
	var self = this;
	var dataArray = new Float32Array(self.sampleSize);

	self.analyzer.getFloatTimeDomainData(dataArray);

	self.dataSubject.onNext(dataArray);

	setTimeout(function() { self.pollAudio(); }, 20);
};

ActivityMonitor.prototype.onAnalyzerReady = function(analyzer) {
	var self = this;
	self.analyzer = analyzer;

	var initialState = new EventState();
	/**
		Use a subject to filter and publish event state.

		.scan is responsible for identify the current state, based on the previous state
		.filter ensures that only the first event for each state is emitted
	**/
	// Subject for
	self.dataSubject = new Rx.Subject();

	// Create a shared stream for multiple subscriptions
	var rawDataStream = self.dataSubject.share();

	// Subscribe to the raw stream for realtime visualization
	rawDataStream.subscribe(function(dataArray) {
		self.volumeVis.update(dataArray);
	});

	// Transform into discrete events
	var eventStream = rawDataStream.map(function(dataArray) {
		// Transform into max volume
		var maxVolume = _(dataArray).map(function (i) {
							return Math.abs(i);}
						).max();

		return {volume:maxVolume};
	}).scan(function(oldState, event) {
		// Transform into aggregate state, based on previous satate
		return self.determineNewState(oldState, event.volume);
	}, initialState).share();


	// Aggregate events for one second
	var oneSecondMaxStream = eventStream.windowWithTime(1000)
		// map the aggregate stream to the max event state and return that
		.flatMap(
			function (windowStream){
				return windowStream.max(
					function(a, b) {
						if (a.volume > b.volume) {
							return 1;
						} else if (a.volume < b.volume) {
							return -1;
						}
						return 0;
					}
				);
			}
		).share();

	// Update the visualization each second with the max volume
	oneSecondMaxStream.subscribe(function(eventState) {
		self.historyVis.update(eventState.volume);
	});

	// Every 60s, send a batch of events to the server
	oneSecondMaxStream.windowWithCount(60).flatMap(function(windowStream) {
		return windowStream.map(function(state) {
			return {"userId" : 1, "volume": state.volume, "timestamp": state.timestamp};
		}).toArray();
	}).subscribe(function(stateArray) {
		 console.log("Sending", stateArray);
		 if (_.max(stateArray, function(state) { return state.volume }) > 0.8) {
		 	console.log(new Date(), "Barking detected");
		 } else {
		 	console.log(new Date(), "All quiet");
		 }
	});



	// Record state transitions
	eventStream.filter(function(state) {
		// Filter out duplicate state (we only care about transitions)
		return state.prevMode != state.mode;
	}).subscribe(function(state) {
		// Record state transitions
		self.recordState(state);
	});

	self.pollAudio();
}


function startRecordingResponse() {
	var $btn = $("#record-response");
	$btn.addClass("disabled");


	navigator.getUserMedia = (navigator.getUserMedia ||
        navigator.webkitGetUserMedia ||
        navigator.mozGetUserMedia ||
        navigator.msGetUserMedia);

    navigator.getUserMedia( {audio:true},

        function (stream) {
            var audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
            var source    = audioCtx.createMediaStreamSource(stream);

            var recorder = new Recorder(source, {workerPath: "recorderWorker.js", numChannels:1});
            recorder.record();

			setTimeout(function() {stopRecordingResponse(recorder)}, 5000);
        },
        function (err) {
            console.log('The following gUM error occured: ', err);
        }
    );

}

function stopRecordingResponse(recorder) {
	recorder.stop();
	recorder.exportWAV(function(wavBlob) {
		console.log("Got wav: ", wavBlob)

		// Need to use reader to conver blob to Uint8Array
        var reader = new FileReader();
        reader.addEventListener("loadend", function() {

        	console.log("Got result", wavBlob, 	reader.result);
        	Meteor.call("saveFile", new Uint8Array(reader.result));
			recorder.clear();
        });
        reader.readAsArrayBuffer(wavBlob);

	});
	var $btn = $("#record-response");
	$btn.removeClass("disabled");
}

function HistoryVisualization() {
	this.size = 300;
	this.paused = false;
	var labels = _.fill(new Array(this.size), "");
	labels[240] = "-1 min"
	labels[180] = "-2 min"
	labels[120] = "-3 min"
	labels[60] = "-4 min"
	labels[0] = "-5 min"
	var datasets = [
			{
				data: _.fill(new Array(this.size), 0)
			}
		];

	var ctx = $("#history_chart").get(0).getContext("2d");
	this.chart = new Chart(ctx).Line({labels: labels, datasets: datasets},
		{
			showTooltips:false,
			animation:false,
			scaleStartValue:0,
			scaleOverride: true,
			scaleSteps: 1,
			scaleStepWidth: 1,
			scaleShowVerticalLines: false,
			bezierCurve:false,
			pointDot:false
		});
	this.update(0);
}

HistoryVisualization.prototype.update = function(newValue) {
	if (this.paused) {
		return;
	}

	var i = 0;
	var dataPoints = this.chart.datasets[0].points;
	for (; i < dataPoints.length-1; i++){
		dataPoints[i].value = dataPoints[i+1].value;
	}

	dataPoints[dataPoints.length -1 ].value = newValue;
	this.chart.update();
}

HistoryVisualization.prototype.suspend = function() {
	this.paused = true;
}

HistoryVisualization.prototype.resume = function() {
	this.paused = false;
}

var VolumeVisualization = function(opts) {
	if (typeof opts === "undefined") {
		opts = {};
	}

	if (!opts.id) throw "id required";
	if (!opts.sampleSize || isNaN(opts.sampleSize)) throw "sampleSize must be a number";

	var downsampleFactor = 20;
	var points = new Array(parseInt(opts.sampleSize/downsampleFactor));
	var labels = new Array(points.length);
	var i;
	var length = points.length;
	for(i=0; i < length; i++) {
		points[i] = 0;
		labels[i] = "";
	}


	var ctx = $("#" + opts.id).get(0).getContext("2d");
	var data = {

	    labels: labels,
	    datasets: [{
	            label: "Current Activity",
	            strokeColor: "rgba(110,55,55,0.5)",
	            data: points
	        },
	    ]
	};


	var options = {
		bezierCurve: true,
		animation: false,
		pointDot: false,
		datasetFill: false,
		datasetStrokeWidth: 3,
		scaleStartValue: -1,
		scaleOverride: true,
		scaleStepWidth: 1,
		scaleSteps: 2,
		scaleShowVerticalLines: false
	};

	var lineChart = new Chart(ctx).LineWithThreshold(data, options);

	function updateLineChart(data) {
		var points = lineChart.datasets[0].points;
		//myNewChart.labels.push(event.value);
		var i = 0;
		for (; i < points.length; i++) {
			points[i].value = data[i * downsampleFactor];
		}

		lineChart.update();
	}

	var barData = {
		labels: [""],
		datasets: [{
			data:[0]
		}]
	};
	var barOptions = {
		animation: false,
		scaleStartValue: 0,
		scaleOverride: true,
		scaleStepWidth: 1,
		scaleSteps: 1
	};

	var ctx2 = $("#volume_visualization2").get(0).getContext("2d");
	var barChart = new Chart(ctx2).BarWithThreshold(barData, barOptions);

	function updateBarChart(data) {

		var max = _(data).map(function (val) { return Math.abs(val); }).max();

		barChart.datasets[0].bars[0].value = max;
		barChart.update();
	}

	return {
		"lineChart": lineChart,
		"update": function(data) {
			updateLineChart(data);
			updateBarChart(data);
		}
	};

};

function drawThresholdLine(self) {
    var scale = self.scale

    // draw line
		var ctx = self.chart.ctx;
		console.log(self);
		var y = ctx.canvas.height * 0.2;
		var pLeft = {x:scale.xScalePaddingLeft, y:scale.startPoint}
		var pRight = {x: ctx.canvas.width, y:y}
    ctx.fillStyle = 'rgba(255,230,230,0.5)';
		ctx.fillRect(pLeft.x,pLeft.y,pRight.x, pRight.y)
		/*
    ctx.beginPath();
    ctx.moveTo(pLeft.x, pLeft.y);
    ctx.strokeStyle = '#b88888';
		ctx.lineWidth = 3;
    ctx.lineTo(pRight.x, pRight.y);
    ctx.stroke();
		ctx.textAlign = 'center';

		var txt = "BARKING DETECTED";
		var txtDim = ctx.measureText(ctx);
		ctx.fillText("BARKING DETECTED", ctx.canvas.width/2, pLeft.y)
		*/
}

Chart.types.Bar.extend({
		name: "BarWithThreshold",
		draw: function() {
			Chart.types.Bar.prototype.draw.apply(this, arguments);
			drawThresholdLine(this);
		}
});

Chart.types.Line.extend({
		name: "LineWithThreshold",
		draw: function() {
			Chart.types.Line.prototype.draw.apply(this, arguments);
			drawThresholdLine(this);
		}
});
