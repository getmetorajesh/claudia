/*global describe, require, it, expect, beforeEach, afterEach, console, global, __dirname */
const underTest = require('../src/commands/update'),
	destroyObjects = require('./util/destroy-objects'),
	create = require('../src/commands/create'),
	shell = require('shelljs'),
	tmppath = require('../src/util/tmppath'),
	callApi = require('../src/util/call-api'),
	ArrayLogger = require('../src/util/array-logger'),
	fs = require('../src/util/fs-promise'),
	path = require('path'),
	aws = require('aws-sdk'),
	os = require('os'),
	awsRegion = require('./util/test-aws-region');
describe('update', () => {
	'use strict';
	let workingdir, testRunName,  lambda, newObjects;
	const invoke = function (url, options) {
		if (!options) {
			options = {};
		}
		options.retry = 403;
		return callApi(newObjects.restApi, awsRegion, url, options);
	};
	beforeEach(() => {
		workingdir = tmppath();
		testRunName = 'test' + Date.now();
		lambda = new aws.Lambda({region: awsRegion});
		newObjects = {workingdir: workingdir};
		shell.mkdir(workingdir);
	});
	afterEach(done => {
		destroyObjects(newObjects).then(done, done.fail);
	});
	it('fails when the source dir does not contain the project config file', done => {
		underTest({source: workingdir}).then(done.fail, reason => {
			expect(reason).toEqual('claudia.json does not exist in the source folder');
			done();
		});
	});
	it('fails if the source folder is same as os tmp folder', done => {
		shell.cp('-rf', 'spec/test-projects/hello-world/*', os.tmpdir());
		fs.writeFileSync(path.join(os.tmpdir(), 'claudia.json'), JSON.stringify({lambda: {name: 'xxx', region: 'us-east-1'}}), 'utf8');
		underTest({source: os.tmpdir()}).then(done.fail, message => {
			expect(message).toEqual('Source directory is the Node temp directory. Cowardly refusing to fill up disk with recursive copy.');
			done();
		});
	});
	it('fails when the project config file does not contain the lambda name', done => {
		fs.writeFileSync(path.join(workingdir, 'claudia.json'), '{}', 'utf8');
		underTest({source: workingdir}).then(done.fail, reason => {
			expect(reason).toEqual('invalid configuration -- lambda.name missing from claudia.json');
			done();
		});
	});
	it('fails when the project config file does not contain the lambda region', done => {
		fs.writeFileSync(path.join(workingdir, 'claudia.json'), JSON.stringify({lambda: {name: 'xxx'}}), 'utf8');
		underTest({source: workingdir}).then(done.fail, reason => {
			expect(reason).toEqual('invalid configuration -- lambda.region missing from claudia.json');
			done();
		});
	});
	it('fails if local dependencies and optional dependencies are mixed', done => {
		shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
		underTest({source: workingdir, 'use-local-dependencies': true, 'optional-dependencies': false}).then(done.fail, message => {
			expect(message).toEqual('incompatible arguments --use-local-dependencies and --no-optional-dependencies');
			done();
		});
	});

	describe('when the config exists', () => {
		beforeEach(done => {
			shell.cp('-r', 'spec/test-projects/hello-world/*', workingdir);
			create({name: testRunName, region: awsRegion, source: workingdir, handler: 'main.handler'}).then(result => {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				shell.cp('-rf', 'spec/test-projects/echo/*', workingdir);
			}).then(done, done.fail);
		});
		it('fails if the lambda no longer exists', done => {
			fs.readFileAsync(path.join(workingdir, 'claudia.json'), 'utf8')
			.then(JSON.parse)
			.then(contents => {
				contents.lambda.name = contents.lambda.name + '-xxx';
				return contents;
			}).then(JSON.stringify)
			.then(contents => {
				return fs.writeFileAsync(path.join(workingdir, 'claudia.json'), contents, 'utf8');
			}).then(() => {
				return underTest({source: workingdir});
			}).then(done.fail, reason => {
				expect(reason.code).toEqual('ResourceNotFoundException');
			}).then(done);
		});
		it('validates the package before updating the lambda', done => {
			shell.cp('-rf', 'spec/test-projects/echo-dependency-problem/*', workingdir);
			underTest({source: workingdir})
			.then(done.fail, reason => {
				expect(reason).toEqual('cannot require ./main after clean installation. Check your dependencies.');
			}).then(() => {
				return lambda.listVersionsByFunction({FunctionName: testRunName}).promise();
			}).then(result => {
				expect(result.Versions.length).toEqual(2);
			}).then(done, done.fail);
		});
		it('creates a new version of the lambda function', done => {
			underTest({source: workingdir}).then(lambdaFunc => {
				expect(new RegExp('^arn:aws:lambda:' + awsRegion + ':[0-9]+:function:' + testRunName + ':2$').test(lambdaFunc.FunctionArn)).toBeTruthy();
			}).then(() => {
				return lambda.listVersionsByFunction({FunctionName: testRunName}).promise();
			}).then(result => {
				expect(result.Versions.length).toEqual(3);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
				expect(result.Versions[2].Version).toEqual('2');
			}).then(done, done.fail);
		});
		it('updates the lambda with a new version', done => {
			underTest({source: workingdir}).then(() => {
				return lambda.invoke({FunctionName: testRunName, Payload: JSON.stringify({message: 'aloha'})}).promise();
			}).then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('{"message":"aloha"}');
			}).then(done, done.fail);
		});

		it('keeps the archive on the disk if --keep is specified', done => {
			underTest({source: workingdir, keep: true}).then(result => {
				expect(result.archive).toBeTruthy();
				expect(shell.test('-e', result.archive));
			}).then(done, done.fail);
		});

		it('uses local dependencies if requested', done => {
			shell.cp('-rf', path.join(__dirname, 'test-projects', 'local-dependencies', '*'), workingdir);

			shell.rm('-rf', path.join(workingdir, 'node_modules'));
			shell.mkdir(path.join(workingdir, 'node_modules'));
			shell.cp('-r', path.join(workingdir, 'local_modules', '*'),  path.join(workingdir, 'node_modules'));

			underTest({source: workingdir, 'use-local-dependencies': true}).then(() => {
				return lambda.invoke({FunctionName: testRunName, Payload: JSON.stringify({message: 'aloha'})}).promise();
			}).then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('"hello local"');
			}).then(done, done.fail);
		});
		it('removes optional dependencies after validation if requested', done => {
			shell.cp('-rf', path.join(__dirname, '/test-projects/optional-dependencies/*'), workingdir);
			underTest({source: workingdir, 'optional-dependencies': false}).then(() => {
				return lambda.invoke({FunctionName: testRunName}).promise();
			}).then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('{"endpoint":"https://s3.amazonaws.com/","modules":[".bin","huh"]}');
			}).then(done, done.fail);
		});
		it('rewires relative dependencies to reference original location after copy', done => {
			shell.cp('-r', path.join(__dirname, 'test-projects/relative-dependencies/*'), workingdir);
			shell.cp('-r', path.join(workingdir, 'claudia.json'), path.join(workingdir, 'lambda'));
			underTest({source: path.join(workingdir, 'lambda')}).then(() => {
				return lambda.invoke({FunctionName: testRunName}).promise();
			}).then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('"hello relative"');
			}).then(done, done.fail);
		});

		it('uses a s3 bucket if provided', done => {
			const s3 = new aws.S3(),
				logger = new ArrayLogger(),
				bucketName = testRunName + '-bucket';
			let archivePath;
			s3.createBucket({
				Bucket: bucketName
			}).promise().then(() => {
				newObjects.s3bucket = bucketName;
			}).then(() => {
				return underTest({keep: true, 'use-s3-bucket': bucketName, source: workingdir}, logger);
			}).then(result => {
				const expectedKey = path.basename(result.archive);
				archivePath = result.archive;
				expect(result.s3key).toEqual(expectedKey);
				return s3.headObject({
					Bucket: bucketName,
					Key: expectedKey
				}).promise();
			}).then(fileResult => {
				expect(parseInt(fileResult.ContentLength)).toEqual(fs.statSync(archivePath).size);
			}).then(() => {
				expect(logger.getApiCallLogForService('s3', true)).toEqual(['s3.upload']);
			}).then(() => {
				return lambda.invoke({FunctionName: testRunName, Payload: JSON.stringify({message: 'aloha'})}).promise();
			}).then(lambdaResult => {
				expect(lambdaResult.StatusCode).toEqual(200);
				expect(lambdaResult.Payload).toEqual('{"message":"aloha"}');
			}).then(done, done.fail);
		});

		it('adds the version alias if supplied', done => {
			underTest({source: workingdir, version: 'great'}).then(() => {
				return lambda.getAlias({FunctionName: testRunName, Name: 'great'}).promise();
			}).then(result => {
				expect(result.FunctionVersion).toEqual('2');
			}).then(done, done.fail);
		});

		it('checks the current dir if the source is not provided', done => {
			shell.cd(workingdir);
			underTest().then(lambdaFunc => {
				expect(new RegExp('^arn:aws:lambda:' + awsRegion + ':[0-9]+:function:' + testRunName + ':2$').test(lambdaFunc.FunctionArn)).toBeTruthy();
				expect(lambdaFunc.FunctionName).toEqual(testRunName);
				return lambda.invoke({FunctionName: testRunName, Payload: JSON.stringify({message: 'aloha'})}).promise();
			}).then(done, done.fail);
		});
	});
	describe('when the lambda project contains a proxy api', () => {
		beforeEach(done => {
			shell.cp('-r', 'spec/test-projects/apigw-proxy-echo/*', workingdir);
			create({name: testRunName, version: 'original', region: awsRegion, source: workingdir, handler: 'main.handler', 'deploy-proxy-api': true}).then(result => {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				newObjects.restApi = result.api && result.api.id;
			}).then(done, done.fail);
		});
		it('if using a different version, deploys a new stage', done => {
			underTest({source: workingdir, version: 'development'}).then(result => {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/development');
			}).then(() => {
				return invoke('development/hello?abc=def');
			}).then(contents => {
				const params = JSON.parse(contents.body);
				expect(params.queryStringParameters).toEqual({abc: 'def'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.path).toEqual('/hello');
				expect(params.requestContext.stage).toEqual('development');
			}).then(done, e => {
				console.log(e);
				done.fail();
			});
		});
	});
	describe('when the lambda project contains a web api', () => {
		let originaldir, updateddir;
		beforeEach(done => {
			originaldir =  path.join(workingdir, 'original');
			updateddir = path.join(workingdir, 'updated');
			shell.mkdir(originaldir);
			shell.mkdir(updateddir);
			shell.cp('-r', 'spec/test-projects/api-gw-hello-world/*', originaldir);
			shell.cp('-r', 'spec/test-projects/api-gw-echo/*', updateddir);
			create({name: testRunName, version: 'original', region: awsRegion, source: originaldir, 'api-module': 'main'}).then(result => {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
				newObjects.restApi = result.api && result.api.id;
				shell.cp(path.join(originaldir, 'claudia.json'), updateddir);
			}).then(done, done.fail);
		});
		it('fails if the api no longer exists', done => {
			fs.readFileAsync(path.join(updateddir, 'claudia.json'), 'utf8')
			.then(JSON.parse)
			.then(contents => {
				contents.api.id = contents.api.id + '-xxx';
				return contents;
			}).then(JSON.stringify)
			.then(contents => {
				return fs.writeFileAsync(path.join(updateddir, 'claudia.json'), contents, 'utf8');
			}).then(() => {
				return underTest({source: updateddir});
			}).then(done.fail, reason => {
				expect(reason.code).toEqual('NotFoundException');
			}).then(() => {
				return lambda.listVersionsByFunction({FunctionName: testRunName}).promise();
			}).then(result => {
				expect(result.Versions.length).toEqual(2);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
			}).then(done, done.fail);
		});
		it('validates the package before creating a new lambda version', done => {
			shell.cp('-rf', 'spec/test-projects/echo-dependency-problem/*', updateddir);
			underTest({source: updateddir}).then(done.fail, reason => {
				expect(reason).toEqual('cannot require ./main after clean installation. Check your dependencies.');
			}).then(() => {
				return lambda.listVersionsByFunction({FunctionName: testRunName}).promise();
			}).then(result => {
				expect(result.Versions.length).toEqual(2);
				expect(result.Versions[0].Version).toEqual('$LATEST');
				expect(result.Versions[1].Version).toEqual('1');
			}).then(done, done.fail);
		});


		it('updates the api using the configuration from the api module', done => {
			return underTest({source: updateddir}).then(result => {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/latest');
			}).then(() => {
				return invoke('latest/echo?name=mike');
			}).then(contents => {
				const params = JSON.parse(contents.body);
				expect(params.queryStringParameters).toEqual({name: 'mike'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.requestContext.resourcePath).toEqual('/echo');
				expect(params.stageVariables).toEqual({
					lambdaVersion: 'latest'
				});
			}).then(done, done.fail);
		});
		it('upgrades the function handler from 1.x', done => {
			lambda.updateFunctionConfiguration({
				FunctionName: testRunName,
				Handler: 'main.router'
			}).promise().then(() => {
				return underTest({source: updateddir});
			}).then(result => {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/latest');
			}).then(() => {
				return invoke('latest/echo?name=mike');
			}).then(contents => {
				const params = JSON.parse(contents.body);
				expect(params.queryStringParameters).toEqual({name: 'mike'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.requestContext.resourcePath).toEqual('/echo');
				expect(params.stageVariables).toEqual({
					lambdaVersion: 'latest'
				});
			}).then(done, done.fail);
		});

		it('works when the source is a relative path', done => {
			shell.cd(path.dirname(updateddir));
			updateddir = './' + path.basename(updateddir);
			return underTest({source: updateddir}).then(result => {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/latest');
			}).then(() => {
				return invoke('latest/echo?name=mike');
			}).then(contents => {
				const params = JSON.parse(contents.body);
				expect(params.queryStringParameters).toEqual({name: 'mike'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.requestContext.resourcePath).toEqual('/echo');
				expect(params.stageVariables).toEqual({
					lambdaVersion: 'latest'
				});
			}).then(done, done.fail);
		});

		it('works with non-reentrant modules', done => {
			global.MARKED = false;
			shell.cp('-rf', 'spec/test-projects/non-reentrant/*', updateddir);
			underTest({source: updateddir}).then(done, done.fail);
		});
		it('when the version is provided, creates the deployment with that name', done => {
			underTest({source: updateddir, version: 'development'}).then(result => {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/development');
			}).then(() => {
				return invoke('development/echo?name=mike');
			}).then(contents => {
				const params = JSON.parse(contents.body);
				expect(params.queryStringParameters).toEqual({name: 'mike'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.requestContext.resourcePath).toEqual('/echo');
				expect(params.stageVariables).toEqual({
					lambdaVersion: 'development'
				});
			}).then(done, done.fail);
		});
		it('adds an api config cache if requested', done => {
			underTest({source: updateddir, version: 'development', 'cache-api-config': 'claudiaConfig'}).then(result => {
				expect(result.url).toEqual('https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/development');
			}).then(() => {
				return invoke('development/echo?name=mike');
			}).then(contents => {
				const params = JSON.parse(contents.body);
				expect(params.queryStringParameters).toEqual({name: 'mike'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.requestContext.resourcePath).toEqual('/echo');
				expect(params.stageVariables).toEqual({
					lambdaVersion: 'development',
					claudiaConfig: 'nWvdJ3sEScZVJeZSDq4LZtDsCZw9dDdmsJbkhnuoZIY='
				});
			}).then(done, done.fail);
		});
		it('if using a different version, leaves the old one intact', done => {
			underTest({source: updateddir, version: 'development'}).then(() => {
				return invoke('original/hello');
			}).then(contents => {
				expect(contents.body).toEqual('"hello world"');
			}).then(done, done.fail);
		});
		it('if using the same version, rewrites the old one', done => {
			underTest({source: updateddir, version: 'original'}).then(() => {
				return invoke('original/echo?name=mike');
			}).then(contents => {
				const params = JSON.parse(contents.body);
				expect(params.queryStringParameters).toEqual({name: 'mike'});
				expect(params.requestContext.httpMethod).toEqual('GET');
				expect(params.requestContext.resourcePath).toEqual('/echo');
				expect(params.stageVariables).toEqual({
					lambdaVersion: 'original'
				});
			}).then(done, done.fail);
		});

		it('executes post-deploy if provided with the api', done => {
			shell.cp('-rf', 'spec/test-projects/api-gw-postdeploy/*', updateddir);
			underTest({
				source: updateddir,
				version: 'development',
				postcheck: 'option-123',
				postresult: 'option-result-post'
			}).then(updateResult => {
				expect(updateResult.deploy).toEqual({
					result: 'option-result-post',
					wasApiCacheUsed: false
				});
			}).then(() => {
				return invoke('postdeploy/hello');
			}).then(contents => {
				expect(JSON.parse(contents.body)).toEqual({
					'postinstallfname': testRunName,
					'postinstallalias': 'development',
					'postinstallapiid': newObjects.restApi,
					'hasPromise': 'true',
					'postinstallapiUrl': 'https://' + newObjects.restApi + '.execute-api.' + awsRegion + '.amazonaws.com/development',
					'hasAWS': 'true',
					'postinstallregion': awsRegion,
					'postinstalloption': 'option-123',
					'lambdaVersion': 'development'
				});
			}).then(done, e => {
				console.log(JSON.stringify(e));
				done.fail();
			});
		});
		it('passes cache check results to the post-deploy step', done => {
			shell.cp('-rf', 'spec/test-projects/api-gw-postdeploy/*', updateddir);
			underTest({
				source: updateddir,
				version: 'development',
				postcheck: 'option-123',
				'cache-api-config': 'claudiaConfig',
				postresult: 'option-result-post'
			}).then(updateResult => {
				expect(updateResult.deploy.wasApiCacheUsed).toBeFalsy();
				return underTest({
					source: updateddir,
					version: 'development',
					postcheck: 'option-123',
					'cache-api-config': 'claudiaConfig',
					postresult: 'option-result-post'
				});
			}).then(updateResult => {
				expect(updateResult.deploy.wasApiCacheUsed).toBeTruthy();
			}).then(done, done.fail);
		});
	});
	it('logs call execution', done => {
		const logger = new ArrayLogger();
		shell.cp('-r', 'spec/test-projects/api-gw-hello-world/*', workingdir);
		create({name: testRunName, region: awsRegion, source: workingdir, 'api-module': 'main'}).then(result => {
			newObjects.lambdaRole = result.lambda && result.lambda.role;
			newObjects.restApi = result.api && result.api.id;
			newObjects.lambdaFunction = result.lambda && result.lambda.name;
		}).then(() => {
			return underTest({source: workingdir, version: 'new'}, logger);
		}).then(() => {
			expect(logger.getStageLog(true).filter(entry => {
				return entry !== 'rate-limited by AWS, waiting before retry';
			})).toEqual([
				'loading Lambda config',
				'packaging files',
				'validating package',
				'updating configuration',
				'zipping package',
				'updating Lambda',
				'setting version alias',
				'updating REST API'
			]);
			expect(logger.getApiCallLogForService('lambda', true)).toEqual([
				'lambda.getFunctionConfiguration', 'lambda.updateFunctionCode', 'lambda.updateAlias', 'lambda.createAlias'
			]);
			expect(logger.getApiCallLogForService('iam', true)).toEqual([]);
			expect(logger.getApiCallLogForService('sts', true)).toEqual(['sts.getCallerIdentity']);
			expect(logger.getApiCallLogForService('apigateway', true)).toEqual([
				'apigateway.getRestApi',
				'apigateway.setupRequestListeners',
				'apigateway.setAcceptHeader',
				'apigateway.getResources',
				'apigateway.deleteResource',
				'apigateway.createResource',
				'apigateway.putMethod',
				'apigateway.putIntegration',
				'apigateway.putMethodResponse',
				'apigateway.putIntegrationResponse',
				'apigateway.createDeployment'
			]);
		}).then(done, done.fail);
	});
	describe('environment variables', () => {
		let standardEnvKeys, logger;
		const nonStandard = function (key) {
			return standardEnvKeys.indexOf(key) < 0;
		};
		beforeEach(done => {
			logger = new ArrayLogger();
			standardEnvKeys = [
				'PATH', 'LANG', 'LD_LIBRARY_PATH', 'LAMBDA_TASK_ROOT', 'LAMBDA_RUNTIME_DIR', 'AWS_REGION',
				'AWS_DEFAULT_REGION', 'AWS_LAMBDA_LOG_GROUP_NAME', 'AWS_LAMBDA_LOG_STREAM_NAME',
				'AWS_LAMBDA_FUNCTION_NAME', 'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_LAMBDA_FUNCTION_VERSION',
				'NODE_PATH', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
				'AWS_EXECUTION_ENV'
			].sort();
			shell.cp('-r', 'spec/test-projects/env-vars/*', workingdir);
			create({
				name: testRunName,
				version: 'original',
				region: awsRegion,
				source: workingdir,
				'handler': 'main.handler',
				'set-env': 'XPATH=/var/www,YPATH=/var/lib'
			}).then(result => {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
			}).then(done, done.fail);
		});
		it('does not change environment variables if set-env not provided', done => {
			return underTest({source: workingdir, version: 'new'}, logger).then(() => {
				return lambda.getFunctionConfiguration({
					FunctionName: testRunName,
					Qualifier: 'new'
				}).promise();
			}).then(configuration => {
				expect(configuration.Environment).toEqual({
					Variables: {
						'XPATH': '/var/www',
						'YPATH': '/var/lib'
					}
				});
			}).then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					Qualifier: 'new',
					InvocationType: 'RequestResponse'
				}).promise();
			}).then(result => {
				const env = JSON.parse(result.Payload);
				expect(Object.keys(env).filter(nonStandard).sort()).toEqual(['XPATH', 'YPATH']);
				expect(env.XPATH).toEqual('/var/www');
				expect(env.YPATH).toEqual('/var/lib');
			}).then(done, done.fail);
		});
		it('changes environment variables if set-env is provided', done => {
			return underTest({source: workingdir, version: 'new', 'set-env': 'XPATH=/opt,ZPATH=/usr'}, logger).then(() => {
				return lambda.getFunctionConfiguration({
					FunctionName: testRunName,
					Qualifier: 'new'
				}).promise();
			}).then(configuration => {
				expect(configuration.Environment).toEqual({
					Variables: {
						'XPATH': '/opt',
						'ZPATH': '/usr'
					}
				});
			}).then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					Qualifier: 'new',
					InvocationType: 'RequestResponse'
				}).promise();
			}).then(result => {
				const env = JSON.parse(result.Payload);
				expect(Object.keys(env).filter(nonStandard).sort()).toEqual(['XPATH', 'ZPATH']);
				expect(env.XPATH).toEqual('/opt');
				expect(env.YPATH).toBeFalsy();
				expect(env.ZPATH).toEqual('/usr');
			}).then(done, done.fail);
		});
		it('changes env variables specified in a JSON file', done => {
			const envpath = path.join(workingdir, 'env.json');
			fs.writeFileSync(envpath, JSON.stringify({'XPATH': '/opt', 'ZPATH': '/usr'}), 'utf8');
			return underTest({source: workingdir, version: 'new', 'set-env-from-json': envpath}, logger).then(() => {
				return lambda.getFunctionConfiguration({
					FunctionName: testRunName,
					Qualifier: 'new'
				}).promise();
			}).then(configuration => {
				expect(configuration.Environment).toEqual({
					Variables: {
						'XPATH': '/opt',
						'ZPATH': '/usr'
					}
				});
			}).then(() => {
				return lambda.invoke({
					FunctionName: testRunName,
					Qualifier: 'new',
					InvocationType: 'RequestResponse'
				}).promise();
			}).then(result => {
				const env = JSON.parse(result.Payload);
				expect(Object.keys(env).filter(nonStandard).sort()).toEqual(['XPATH', 'ZPATH']);
				expect(env.XPATH).toEqual('/opt');
				expect(env.YPATH).toBeFalsy();
				expect(env.ZPATH).toEqual('/usr');
			}).then(done, done.fail);
		});
		it('refuses to work if reading the variables fails', done => {
			return underTest({source: workingdir, version: 'new', 'set-env': 'XPATH,ZPATH=/usr'}, logger).then(done.fail, message => {
				expect(message).toEqual('Cannot read variables from set-env, Invalid CSV element XPATH');
				expect(logger.getApiCallLogForService('lambda', true)).toEqual([]);
				expect(logger.getApiCallLogForService('iam', true)).toEqual([]);
				done();
			});
		});

		it('loads up the environment variables while validating the package to allow any code that expects them to initialize -- fix for https://github.com/claudiajs/claudia/issues/96', done => {
			shell.cp('-rf', 'spec/test-projects/throw-if-not-env/*', workingdir);
			process.env.TEST_VAR = '';
			underTest({source: workingdir, version: 'new', 'set-env': 'TEST_VAR=abc'}, logger).then(done, done.fail);
		});

	});
});
