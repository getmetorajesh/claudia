/*global exports*/
exports.apiConfig = function () {
	'use strict';
	return {
		version: 3,
		routes: { echo: { 'GET' : {} }}
	};
};
exports.router = function (event, context) {
	'use strict';
	context.succeed({
		body: JSON.stringify(event),
		statusCode: 200
	});
};
