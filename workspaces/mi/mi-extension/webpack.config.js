/**
 * Copyright (c) 2025 WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//@ts-check

'use strict';

const path = require('path');
const dotenv = require('dotenv');
const webpack = require('webpack');
const { createEnvDefinePlugin } = require('../../../common/scripts/env-webpack-helper');

const envPath = path.resolve(__dirname, '.env');
const env = dotenv.config({ path: envPath }).parsed;
console.log("Fetching values for environment variables...");
// @ts-ignore
const { envKeys, missingVars } = createEnvDefinePlugin(env);
if (missingVars.length > 0) {
  console.warn(
    '\n⚠️  Environment Variable Configuration Warning:\n' +
    `Missing required environment variables: ${missingVars.join(', ')}\n` +
    `Please provide values in either .env file or runtime environment.\n`
  );
}

/** @type {import('webpack').Configuration} */
module.exports = {
  target: 'node',
	mode: 'none',

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  externals: {
    vscode: 'commonjs vscode',
    // Native / large modules loaded at runtime from node_modules (dev) or
    // dist/node_modules/ (production VSIX — copied by scripts/copy-native-modules.js).
    // better-sqlite3 must be rebuilt for Electron ABI via scripts/rebuild-native.js.
    'better-sqlite3': 'commonjs better-sqlite3',
    '@xenova/transformers': 'commonjs @xenova/transformers',
    // onnxruntime-node must also be external so the extension bundle and
    // @xenova/transformers share the SAME CJS module instance at runtime.
    // This allows embedder.ts to temporarily patch InferenceSession.create
    // to inject the desired ONNX execution providers (CoreML/MPS, CPU, etc.)
    // before the pipeline is loaded.
    'onnxruntime-node': 'commonjs onnxruntime-node',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      'zod/v3': 'zod',
      'zod/v4': 'zod'
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      },
      {
        test: /\.node$/,
        use: 'node-loader'
      }
    ]
  },
  plugins: [
      new webpack.DefinePlugin(envKeys),
      new webpack.NormalModuleReplacementPlugin(
        /^zod\/(v3|v4)$/,
        (resource) => {
          resource.request = 'zod';
        }
      ),
  ],
  devtool: !process.env.CI ? "nosources-source-map" : undefined,
  infrastructureLogging: {
    level: "log",
  },
  ignoreWarnings: [
    // @opentelemetry/instrumentation and require-in-the-middle use dynamic require()
    // for Node.js module hooking. This is by-design in OTel and harmless at runtime
    // (Langfuse tracing is behind a dev flag and these modules run fine in Node/Electron).
    { module: /@opentelemetry[\/]instrumentation/ },
    { module: /require-in-the-middle/ },
    // Handlebars uses the deprecated require.extensions API internally.
    // It works correctly at runtime in Node.js/Electron; the warnings are cosmetic.
    { module: /handlebars[\/]lib[\/]index\.js$/ },
    // TypeScript compiler (used by ts-morph) and vscode-languageserver-types
    // use dynamic require() in their UMD wrappers. Both work fine at runtime.
    { module: /@ts-morph[\/]common[\/]dist[\/]typescript\.js$/ },
    { module: /typescript[\/]lib[\/]typescript\.js$/ },
    { module: /vscode-languageserver-types[\/]lib[\/]umd[\/]main\.js$/ },
  ],
};
