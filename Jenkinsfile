#!/usr/bin/env groovy

// Jenkins pipeline to check Gerrit merged patchsets.

// Before checking in this file you should validate the syntax with:
// curl --user $USER -X POST -F "jenkinsfile=<Jenkinsfile" https://jenkins.office.dreamchip.de/pipeline-model-converter/validate

def gerrit_project = "project/provideo/sw/companion-module-dct-visca"

pipeline {
    options {
        allowBrokenBuildClaiming()
        buildDiscarder logRotator(
            artifactNumToKeepStr: '25',
            numToKeepStr: '25')
        disableConcurrentBuilds()
        quietPeriod(0)
    }
    agent {
        label('apptainer-builder')
    }
    environment {
        APPTAINER_NAME = "apptainer-provideo"
        APPTAINER_TOOLDIR = "tool-apptainer"
        APPTAINER_RUN = "${APPTAINER_TOOLDIR}/${APPTAINER_NAME}/run.sh"
        APPTAINER_RUN_SUBMIT = "${APPTAINER_RUN} --submit --cpu 2"
        // keep the yarn cache in the workspace, the container home may be read-only
        YARN_CACHE_FOLDER = "${WORKSPACE}/.yarn-cache"
    }
    triggers {
        gerrit(
            customUrl: '',
            gerritProjects: [
                [
                    // Only react to merges on THIS job's branch. In a multibranch
                    // pipeline the Jenkinsfile is loaded by every branch job, so a
                    // "**" pattern made every job trigger on every merge. Scoping to
                    // env.BRANCH_NAME limits each job to its own branch.
                    branches: [
                        [compareType: 'PLAIN', pattern: env.BRANCH_NAME],
                    ],
                    compareType: 'PLAIN',
                    disableStrictForbiddenFileVerification: false,
                    pattern: "${gerrit_project}",
                ],
            ],
            serverName: 'Gerrit DCT',
            triggerOnEvents: [
                changeMerged(),
                wipStateChanged(),
            ],
        )
    }
    stages {
        stage('Prepare') {
            steps {
                sshagent(['77ba5f5a-cefd-41f2-b946-e26565b78d94']) {
                    sh "rm -rf ${APPTAINER_TOOLDIR}"
                    sh "git clone --branch main --depth 1 --origin origin_tools_apptainer ssh://gerrit.office.dreamchip.de:29418/it/apptainer ${APPTAINER_TOOLDIR}"
                }
            }
        }
        stage('install') {
            steps {
                sshagent(['77ba5f5a-cefd-41f2-b946-e26565b78d94']) {
                    // TODO: remove once the yarn/corepack setup in the image is confirmed
                    sh "${APPTAINER_RUN_SUBMIT} bash -c 'echo COREPACK_HOME=\$COREPACK_HOME; ls \$COREPACK_HOME/v1/yarn; corepack --version' || true"
                    sh "${APPTAINER_RUN_SUBMIT} bash -c 'node --version && yarn --version && yarn install --immutable'"
                }
            }
        }
        stage('syntax') {
            steps {
                sshagent(['77ba5f5a-cefd-41f2-b946-e26565b78d94']) {
                    sh "${APPTAINER_RUN_SUBMIT} bash -c 'for f in src/*.js; do node --check \$f || exit 1; done'"
                }
            }
        }
        stage('lint') {
            // eslint errors and prettier formatting warnings only mark the build UNSTABLE
            steps {
                sshagent(['77ba5f5a-cefd-41f2-b946-e26565b78d94']) {
                    catchError(buildResult: 'UNSTABLE', stageResult: 'FAILURE') {
                        sh "${APPTAINER_RUN_SUBMIT} bash -c 'yarn eslint . --format checkstyle --output-file eslint-report.xml'"
                    }
                }
            }
        }
        stage('test') {
            steps {
                sshagent(['77ba5f5a-cefd-41f2-b946-e26565b78d94']) {
                    sh "${APPTAINER_RUN_SUBMIT} bash -c 'yarn test:coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results.xml'"
                }
            }
            post {
                always {
                    junit allowEmptyResults: true, testResults: 'test-results.xml'
                    // report-only for now, no quality gate
                    recordCoverage tools: [[parser: 'COBERTURA', pattern: 'coverage/cobertura-coverage.xml']], \
                        sourceCodeRetention: 'LAST_BUILD'
                }
            }
        }
    }
    post {
        always {
            // publish warnings
            recordIssues ignoreQualityGate: true, \
            tools: [esLint(pattern: 'eslint-report.xml')], \
            trendChartType: 'AGGREGATION_TOOLS'
        }
        changed {
            script {
                if (currentBuild.currentResult == 'SUCCESS') {
                    emailext(
                        subject: '[Fixed] ${DEFAULT_SUBJECT}',
                        body: '${DEFAULT_CONTENT}',
                        recipientProviders: [culprits()],
                        to: '${DEFAULT_RECIPIENTS}',
                        replyTo: '${DEFAULT_REPLYTO}'
                    )
                }
                else {
                    emailext(
                        subject: '${DEFAULT_SUBJECT}',
                        body: '${DEFAULT_CONTENT}',
                        recipientProviders: [culprits()],
                        to: '${DEFAULT_RECIPIENTS}',
                        replyTo: '${DEFAULT_REPLYTO}'
                    )
                }
            }
        }
    }
}
