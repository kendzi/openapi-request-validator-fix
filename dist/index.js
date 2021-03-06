"use strict";
exports.__esModule = true;
var Ajv = require("ajv");
var openapi_jsonschema_parameters_1 = require("openapi-jsonschema-parameters");
var ts_log_1 = require("ts-log");
var contentTypeParser = require('content-type');
var LOCAL_DEFINITION_REGEX = /^#\/([^\/]+)\/([^\/]+)$/;
var OpenAPIRequestValidator = /** @class */ (function () {
    function OpenAPIRequestValidator(args) {
        var _this = this;
        this.logger = ts_log_1.dummyLogger;
        this.loggingKey = '';
        this.requestBodyValidators = {};
        var loggingKey = args && args.loggingKey ? args.loggingKey + ': ' : '';
        this.loggingKey = loggingKey;
        if (!args) {
            throw new Error(loggingKey + "missing args argument");
        }
        if (args.logger) {
            this.logger = args.logger;
        }
        var errorTransformer = typeof args.errorTransformer === 'function' && args.errorTransformer;
        var errorMapper = errorTransformer
            ? extendedErrorMapper(errorTransformer)
            : toOpenapiValidationError;
        var bodyValidationSchema;
        var bodySchema;
        var headersSchema;
        var formDataSchema;
        var pathSchema;
        var querySchema;
        var isBodyRequired;
        if (args.parameters !== undefined) {
            if (Array.isArray(args.parameters)) {
                var schemas = openapi_jsonschema_parameters_1.convertParametersToJSONSchema(args.parameters);
                bodySchema = schemas.body;
                headersSchema = lowercasedHeaders(schemas.headers);
                formDataSchema = schemas.formData;
                pathSchema = schemas.path;
                querySchema = schemas.query;
                isBodyRequired =
                    // @ts-ignore
                    args.parameters.filter(byRequiredBodyParameters).length > 0;
            }
            else {
                throw new Error(loggingKey + "args.parameters must be an Array");
            }
        }
        var v = new Ajv({
            useDefaults: true,
            allErrors: true,
            unknownFormats: 'ignore',
            missingRefs: 'fail',
            // @ts-ignore TODO get Ajv updated to account for logger
            logger: false
        });
        v.removeKeyword('readOnly');
        v.addKeyword('readOnly', {
            modifying: true,
            compile: function (sch) {
                if (sch) {
                    return function validate(data, path, obj, propName) {
                        var isValid = !(sch === true && data != null);
                        validate.errors = [
                            {
                                keyword: 'readOnly',
                                dataPath: path,
                                message: 'is read-only',
                                params: { readOnly: propName }
                            }
                        ];
                        return isValid;
                    };
                }
                return function () { return true; };
            }
        });
        if (args.requestBody) {
            isBodyRequired = args.requestBody.required || false;
        }
        if (args.customFormats) {
            var hasNonFunctionProperty_1;
            Object.keys(args.customFormats).forEach(function (format) {
                var func = args.customFormats[format];
                if (typeof func === 'function') {
                    v.addFormat(format, func);
                }
                else {
                    hasNonFunctionProperty_1 = true;
                }
            });
            if (hasNonFunctionProperty_1) {
                throw new Error(loggingKey + "args.customFormats properties must be functions");
            }
        }
        if (bodySchema) {
            bodyValidationSchema = {
                properties: {
                    body: bodySchema
                }
            };
        }
        if (args.componentSchemas) {
            // openapi v3:
            Object.keys(args.componentSchemas).forEach(function (id) {
                v.addSchema(args.componentSchemas[id], "#/components/schemas/" + id);
            });
        }
        else if (args.schemas) {
            if (Array.isArray(args.schemas)) {
                args.schemas.forEach(function (schema) {
                    var id = schema.id;
                    if (id) {
                        var localSchemaPath = LOCAL_DEFINITION_REGEX.exec(id);
                        if (localSchemaPath && bodyValidationSchema) {
                            var definitions = bodyValidationSchema[localSchemaPath[1]];
                            if (!definitions) {
                                definitions = bodyValidationSchema[localSchemaPath[1]] = {};
                            }
                            definitions[localSchemaPath[2]] = schema;
                        }
                        v.addSchema(schema, id);
                    }
                    else {
                        _this.logger.warn(loggingKey, 'igorning schema without id property');
                    }
                });
            }
            else if (bodySchema) {
                bodyValidationSchema.definitions = args.schemas;
                bodyValidationSchema.components = {
                    schemas: args.schemas
                };
            }
        }
        if (args.externalSchemas) {
            Object.keys(args.externalSchemas).forEach(function (id) {
                v.addSchema(args.externalSchemas[id], id);
            });
        }
        if (args.requestBody) {
            /* tslint:disable-next-line:forin */
            for (var mediaTypeKey in args.requestBody.content) {
                var bodyContentSchema = args.requestBody.content[mediaTypeKey].schema;
                var copied = JSON.parse(JSON.stringify(bodyContentSchema));
                var resolvedSchema = resolveAndSanitizeRequestBodySchema(copied, v);
                this.requestBodyValidators[mediaTypeKey] = v.compile(transformOpenAPIV3Definitions({
                    properties: {
                        body: resolvedSchema
                    },
                    definitions: args.schemas || {},
                    components: { schemas: args.schemas }
                }));
            }
        }
        this.bodySchema = bodySchema;
        this.errorMapper = errorMapper;
        this.isBodyRequired = isBodyRequired;
        this.requestBody = args.requestBody;
        this.validateBody =
            bodyValidationSchema &&
                v.compile(transformOpenAPIV3Definitions(bodyValidationSchema));
        this.validateFormData =
            formDataSchema &&
                v.compile(transformOpenAPIV3Definitions(formDataSchema));
        this.validateHeaders =
            headersSchema && v.compile(transformOpenAPIV3Definitions(headersSchema));
        this.validatePath =
            pathSchema && v.compile(transformOpenAPIV3Definitions(pathSchema));
        this.validateQuery =
            querySchema && v.compile(transformOpenAPIV3Definitions(querySchema));
    }
    OpenAPIRequestValidator.prototype.validateRequest = function (request) {
        var errors = [];
        var err;
        var schemaError;
        var mediaTypeError;
        if (this.bodySchema) {
            if (request.body) {
                if (!this.validateBody({ body: request.body })) {
                    errors.push.apply(errors, withAddedLocation('body', this.validateBody.errors));
                }
            }
            else if (this.isBodyRequired) {
                schemaError = {
                    location: 'body',
                    message: 'request.body was not present in the request.  Is a body-parser being used?',
                    schema: this.bodySchema
                };
            }
        }
        if (this.requestBody) {
            var contentType = request.headers['content-type'];
            var mediaTypeMatch = getSchemaForMediaType(contentType, this.requestBody, this.logger, this.loggingKey);
            if (!mediaTypeMatch) {
                if (contentType) {
                    mediaTypeError = {
                        message: "Unsupported Content-Type " + contentType
                    };
                }
                else if (this.isBodyRequired) {
                    errors.push({
                        keyword: 'required',
                        dataPath: '.body',
                        params: {},
                        message: 'media type is not specified',
                        location: 'body'
                    });
                }
            }
            else {
                var bodySchema = this.requestBody.content[mediaTypeMatch].schema;
                if (request.body) {
                    var validateBody = this.requestBodyValidators[mediaTypeMatch];
                    if (!validateBody({ body: request.body })) {
                        errors.push.apply(errors, withAddedLocation('body', validateBody.errors));
                    }
                }
                else if (this.isBodyRequired) {
                    schemaError = {
                        location: 'body',
                        message: 'request.body was not present in the request.  Is a body-parser being used?',
                        schema: bodySchema
                    };
                }
            }
        }
        if (this.validateFormData && !schemaError) {
            if (!this.validateFormData(request.body)) {
                errors.push.apply(errors, withAddedLocation('formData', this.validateFormData.errors));
            }
        }
        if (this.validatePath) {
            if (!this.validatePath(request.params || {})) {
                errors.push.apply(errors, withAddedLocation('path', this.validatePath.errors));
            }
        }
        if (this.validateHeaders) {
            if (!this.validateHeaders(lowercaseRequestHeaders(request.headers || {}))) {
                errors.push.apply(errors, withAddedLocation('headers', this.validateHeaders.errors));
            }
        }
        if (this.validateQuery) {
            if (!this.validateQuery(request.query || {})) {
                errors.push.apply(errors, withAddedLocation('query', this.validateQuery.errors));
            }
        }
        if (errors.length) {
            err = {
                status: 400,
                errors: errors.map(this.errorMapper)
            };
        }
        else if (schemaError) {
            err = {
                status: 400,
                errors: [schemaError]
            };
        }
        else if (mediaTypeError) {
            err = {
                status: 415,
                errors: [mediaTypeError]
            };
        }
        return err;
    };
    OpenAPIRequestValidator.prototype.validate = function (request) {
        console.warn('validate is deprecated, use validateRequest instead.');
        this.validateRequest(request);
    };
    return OpenAPIRequestValidator;
}());
exports["default"] = OpenAPIRequestValidator;
function byRequiredBodyParameters(param) {
    // @ts-ignore
    return (param["in"] === 'body' || param["in"] === 'formData') && param.required;
}
function extendedErrorMapper(mapper) {
    return function (ajvError) { return mapper(toOpenapiValidationError(ajvError), ajvError); };
}
function getSchemaForMediaType(contentTypeHeader, requestBodySpec, logger, loggingKey) {
    if (!contentTypeHeader) {
        return;
    }
    var contentType;
    try {
        contentType = contentTypeParser.parse(contentTypeHeader).type;
    }
    catch (e) {
        logger.warn(loggingKey, 'failed to parse content-type', contentTypeHeader, e);
        if (e instanceof TypeError && e.message === 'invalid media type') {
            return;
        }
        throw e;
    }
    var content = requestBodySpec.content;
    var subTypeWildCardPoints = 2;
    var wildcardMatchPoints = 1;
    var match;
    var matchPoints = 0;
    for (var mediaTypeKey in content) {
        if (content.hasOwnProperty(mediaTypeKey)) {
            if (mediaTypeKey.indexOf(contentType) > -1) {
                return mediaTypeKey;
            }
            else if (mediaTypeKey === '*/*' && wildcardMatchPoints > matchPoints) {
                match = mediaTypeKey;
                matchPoints = wildcardMatchPoints;
            }
            var contentTypeParts = contentType.split('/');
            var mediaTypeKeyParts = mediaTypeKey.split('/');
            if (mediaTypeKeyParts[1] !== '*') {
                continue;
            }
            else if (contentTypeParts[0] === mediaTypeKeyParts[0] &&
                subTypeWildCardPoints > matchPoints) {
                match = mediaTypeKey;
                matchPoints = subTypeWildCardPoints;
            }
        }
    }
    return match;
}
function lowercaseRequestHeaders(headers) {
    var lowerCasedHeaders = {};
    Object.keys(headers).forEach(function (header) {
        lowerCasedHeaders[header.toLowerCase()] = headers[header];
    });
    return lowerCasedHeaders;
}
function lowercasedHeaders(headersSchema) {
    if (headersSchema) {
        var properties_1 = headersSchema.properties;
        Object.keys(properties_1).forEach(function (header) {
            var property = properties_1[header];
            delete properties_1[header];
            properties_1[header.toLowerCase()] = property;
        });
        if (headersSchema.required && headersSchema.required.length) {
            headersSchema.required = headersSchema.required.map(function (header) {
                return header.toLowerCase();
            });
        }
    }
    return headersSchema;
}
function toOpenapiValidationError(error) {
    var validationError = {
        path: 'instance' + error.dataPath,
        errorCode: error.keyword + ".openapi.requestValidation",
        message: error.message,
        location: error.location
    };
    if (error.keyword === '$ref') {
        delete validationError.errorCode;
        validationError.schema = { $ref: error.params.ref };
    }
    if (error.params.missingProperty) {
        validationError.path += '.' + error.params.missingProperty;
    }
    validationError.path = validationError.path.replace(error.location === 'body' ? /^instance\.body\.?/ : /^instance\.?/, '');
    if (!validationError.path) {
        delete validationError.path;
    }
    return stripBodyInfo(validationError);
}
function stripBodyInfo(error) {
    if (error.location === 'body') {
        if (typeof error.path === 'string') {
            error.path = error.path.replace(/^body\./, '');
        }
        else {
            // Removing to avoid breaking clients that are expecting strings.
            delete error.path;
        }
        error.message = error.message.replace(/^instance\.body\./, 'instance.');
        error.message = error.message.replace(/^instance\.body /, 'instance ');
    }
    return error;
}
function withAddedLocation(location, errors) {
    errors.forEach(function (error) {
        error.location = location;
    });
    return errors;
}
function resolveAndSanitizeRequestBodySchema(requestBodySchema, v) {
    var resolved;
    var copied;
    if ('properties' in requestBodySchema) {
        var schema_1 = requestBodySchema;
        Object.keys(schema_1.properties).forEach(function (property) {
            var prop = schema_1.properties[property];
            prop = sanitizeReadonlyPropertiesFromRequired(prop);
            if (!prop.hasOwnProperty('$ref') && !prop.hasOwnProperty('items')) {
                prop = resolveAndSanitizeRequestBodySchema(prop, v);
            }
        });
    }
    else if ('$ref' in requestBodySchema) {
        resolved = v.getSchema(requestBodySchema.$ref);
        if (resolved && resolved.schema) {
            copied = JSON.parse(JSON.stringify(resolved.schema));
            copied = sanitizeReadonlyPropertiesFromRequired(copied);
            copied = resolveAndSanitizeRequestBodySchema(copied, v);
            requestBodySchema = copied;
        }
    }
    else if ('items' in requestBodySchema) {
        if ('$ref' in requestBodySchema.items) {
            resolved = v.getSchema(requestBodySchema.items.$ref);
            if (resolved && resolved.schema) {
                copied = JSON.parse(JSON.stringify(resolved.schema));
                copied = sanitizeReadonlyPropertiesFromRequired(copied);
                copied = resolveAndSanitizeRequestBodySchema(copied, v);
                requestBodySchema.items = copied;
            }
        }
    }
    else if ('allOf' in requestBodySchema) {
        requestBodySchema.allOf = requestBodySchema.allOf.map(function (val) {
            val = sanitizeReadonlyPropertiesFromRequired(val);
            return resolveAndSanitizeRequestBodySchema(val, v);
        });
    }
    else if ('oneOf' in requestBodySchema) {
        requestBodySchema.oneOf = requestBodySchema.oneOf.map(function (val) {
            val = sanitizeReadonlyPropertiesFromRequired(val);
            return resolveAndSanitizeRequestBodySchema(val, v);
        });
    }
    else if ('anyOf' in requestBodySchema) {
        requestBodySchema.anyOf = requestBodySchema.anyOf.map(function (val) {
            val = sanitizeReadonlyPropertiesFromRequired(val);
            return resolveAndSanitizeRequestBodySchema(val, v);
        });
    }
    return requestBodySchema;
}
function sanitizeReadonlyPropertiesFromRequired(schema) {
    if ('properties' in schema && 'required' in schema) {
        var readOnlyProps = Object.keys(schema.properties).map(function (key) {
            var prop = schema.properties[key];
            if (prop && 'readOnly' in prop) {
                if (prop.readOnly === true) {
                    return key;
                }
            }
            return;
        });
        readOnlyProps
            .filter(function (i) { return i !== undefined; })
            .forEach(function (value) {
            var index = schema.required.indexOf(value);
            schema.required.splice(index, 1);
        });
    }
    return schema;
}
function recursiveTransformOpenAPIV3Definitions(object) {
    // Transformations //
    // OpenAPIV3 nullable
    if (object.type && object.nullable === true) {
        if (object["enum"]) {
            // Enums can not be null with type null
            object.oneOf = [
                { type: 'null' },
                {
                    type: object.type,
                    "enum": object["enum"]
                }
            ];
            delete object.type;
            delete object["enum"];
        }
        else {
            object.type = [object.type, 'null'];
        }
        delete object.nullable;
    }
    Object.keys(object).forEach(function (attr) {
        if (typeof object[attr] === 'object' && object[attr] !== null) {
            recursiveTransformOpenAPIV3Definitions(object[attr]);
        }
        else if (Array.isArray(object[attr])) {
            object[attr].forEach(function (obj) { return recursiveTransformOpenAPIV3Definitions(obj); });
        }
    });
}
function transformOpenAPIV3Definitions(schema) {
    if (typeof schema !== 'object') {
        return schema;
    }
    var res = JSON.parse(JSON.stringify(schema));
    recursiveTransformOpenAPIV3Definitions(res);
    return res;
}
//# sourceMappingURL=index.js.map